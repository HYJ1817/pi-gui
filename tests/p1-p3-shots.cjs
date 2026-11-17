/* P1–P3 真实 Chromium 渲染验收（离线夹具，不启 Pi、不读用户会话）。
 *
 * 覆盖：
 *   P1 设置入口的 Lucide sliders-horizontal 图标、尺寸、可访问名称与键盘焦点；
 *   P2 历史会话切换 / 连续切换 / 行内重命名后的顶部标题；
 *   P3 同供应商、跨供应商、同名跨供应商、未知容量下的上下文容量与浮层一致性。
 *
 * 用法：node tests/p1-p3-shots.cjs
 * 产物：docs/ui/p1-p3-evidence/shots/ 与 shots-summary.json
 */
'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'ui', 'p1-p3-evidence', 'shots');
const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
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
        .split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (found && fs.existsSync(found)) return found;
    } catch { /* not in path */ }
  }
  return null;
}

const CHROME = findBrowser();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startHarness() {
  const harness = spawn(process.execPath, [path.join(ROOT, 'tests', 'visual-harness.cjs')], {
    env: { ...process.env, HARNESS_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('夹具启动超时')), 15000);
    harness.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    harness.on('exit', (code) => { clearTimeout(timer); reject(new Error('夹具退出 ' + code)); });
  });
  return { harness, url };
}

async function launchChrome() {
  if (!CHROME) throw new Error('未找到 Chrome/Edge；可用 UI2C_CHROME 指定');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-p1p3-shots-'));
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
        const page = targets.find((target) => target.type === 'page');
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
      send: (method, params = {}) => new Promise((resolveSend) => {
        const id = ++idc;
        pending.set(id, resolveSend);
        ws.send(JSON.stringify({ id, method, params }));
      }),
      pageErrors,
    });
    ws.onerror = reject;
    ws.onmessage = (event) => {
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

async function waitFor(cdp, expression, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(cdp, expression);
      if (last) return last;
    } catch (error) { last = String(error.message || error); }
    await sleep(120);
  }
  throw new Error('等待超时: ' + expression + ' 最后值=' + JSON.stringify(last));
}

async function pageSetup(cdp) {
  return evaluate(cdp, `(async () => {
    window.__P = {};
    const [state, usage, sessions, theme, popover, picker, messages] = await Promise.all([
      import('/state.js'), import('/usage.js'), import('/sessions.js'), import('/theme.js'),
      import('/ui/popover.js'), import('/ui3-model-picker.js'), import('/messages.js'),
    ]);
    Object.assign(window.__P, {
      S: state.S, usage, sessions, theme, picker, messages,
      closePop: popover.closePop, currentAnchor: popover.currentAnchor, popVisible: popover.popVisible,
    });
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
  const shot = async (name) => {
    await sleep(220);
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
  const setTheme = async (theme) => {
    await evaluate(cdp, `(async () => { await __P.theme.setThemePreference(${JSON.stringify(theme)}); return document.documentElement.dataset.theme; })()`);
    await sleep(180);
  };
  const title = () => evaluate(cdp, `document.querySelector('#title').textContent`);
  const usageText = () => evaluate(cdp, `document.querySelector('#uNote').textContent`);
  const pctText = () => evaluate(cdp, `document.querySelector('#uPct').textContent`);
  const switchModel = async (provider, modelId) => {
    await evaluate(cdp, `(async () => { __P.closePop(); document.querySelector('#btnModel').click(); return true; })()`);
    await sleep(220);
    const clicked = await evaluate(cdp, `(() => {
      const rail = [...document.querySelectorAll('.model-rail-item')]
        .find((n) => n.dataset.section === 'provider:' + ${JSON.stringify(provider)});
      if (rail) rail.click();
      const item = [...document.querySelectorAll('.ui3-model-item')]
        .find((n) => n.dataset.provider === ${JSON.stringify(provider)} && n.dataset.modelId === ${JSON.stringify(modelId)});
      if (!item) return false;
      item.click();
      return true;
    })()`);
    if (!clicked) throw new Error('模型选择器里没有 ' + provider + '/' + modelId);
    await waitFor(cdp, `__P.S.state?.model?.providerId === ${JSON.stringify(provider)}
      && __P.S.state?.model?.modelId === ${JSON.stringify(modelId)} && __P.S.modelSwitchPending === false`, 10000);
    await sleep(500);
    /* 统一菜单选择后保持打开等待回读；回读完成，验收助手负责收起，
     * 免得后续上下文浮层被菜单挡住。 */
    await evaluate(cdp, `__P.closePop()`);
  };
  const switchToHistorySession = async () => {
    const clicked = await evaluate(cdp, `(() => {
      const row = [...document.querySelectorAll('.pj-sess')]
        .find((r) => r.textContent.includes('帮我把 README'));
      if (!row) return false;
      row.querySelector('.pj-sess-primary').click();
      return true;
    })()`);
    if (!clicked) throw new Error('侧栏没有目标历史会话');
    await sleep(700);
    /* 夹具的 get_state 固定带 sessionName；真实历史会话的自动标题来自列表，
     * 这里把实时名字清空，走与真实会话相同的列表投影路径。 */
    await evaluate(cdp, `(async () => { __P.S.state.sessionName = ''; await __P.sessions.refreshSidebarSessions(); return true; })()`);
    await sleep(500);
  };

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const viewports = [[1320, 820], [700, 600]];
    for (const [width, height] of viewports) {
      for (const theme of ['dark', 'light']) {
        /* 每次从同一个初始会话开始，避免上一轮切换影响标题断言。 */
        await fetch(new URL('/api/__work-surface/session-reset', url));
        /* 真实历史会话的自动标题来自会话文件，Pi 的 sessionName 为空。 */
        await fetch(new URL('/api/__session-name', url), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '' }),
        });
        await cdp.send('Page.navigate', { url });
        await waitFor(cdp, `document.readyState === 'complete' && !!document.querySelector('#btnModel')`, 12000);
        await sleep(900);
        await pageSetup(cdp);
        await waitFor(cdp, `__P.S.bridgeState === 'ready' && (__P.S.models || []).length >= 4
          && document.querySelector('#uNote').textContent.includes('1M')`, 12000);
        await setViewport(width, height);
        await setTheme(theme);

        /* ---------- P1 设置入口图标 ---------- */
        const icon = await evaluate(cdp, `(() => {
          const button = document.querySelector('#navGlobalMore');
          const svg = button.querySelector('svg[data-icon="settings"]');
          const br = button.getBoundingClientRect();
          const sr = svg && svg.getBoundingClientRect();
          return {
            icon: Boolean(svg), paths: svg ? svg.querySelectorAll('path').length : 0,
            circles: svg ? svg.querySelectorAll('circle').length : 0,
            button: [br.width, br.height], svg: sr ? [sr.width, sr.height] : null,
            label: button.getAttribute('aria-label'), title: button.title,
            expanded: button.getAttribute('aria-expanded'),
            stroke: svg ? getComputedStyle(svg).strokeWidth : null,
          };
        })()`);
        metrics.push({ scene: 'p1-settings-icon', width, height, theme, ...icon });
        check(`P1 ${width}×${height} ${theme}: 设置入口渲染 Lucide 齿轮`,
          icon.icon && icon.paths === 1 && icon.circles === 1, icon);
        check(`P1 ${width}×${height} ${theme}: 图标 14×14、按钮 28×28`,
          Math.abs(icon.svg?.[0] - 14) < 0.6 && Math.abs(icon.svg?.[1] - 14) < 0.6
            && Math.abs(icon.button[0] - 28) < 0.6 && Math.abs(icon.button[1] - 28) < 0.6, icon);
        check(`P1 ${width}×${height} ${theme}: tooltip / 无障碍名称 / 展开状态保留`,
          icon.label === '设置' && icon.title === '设置' && icon.expanded === 'false', icon);
        const focused = await evaluate(cdp, `(() => {
          const b = document.querySelector('#navGlobalMore'); b.focus();
          return document.activeElement === b;
        })()`);
        check(`P1 ${width}×${height} ${theme}: 键盘可聚焦`, focused);
        await shot(`p1-settings-icon-${width}x${height}-${theme}`);

        await evaluate(cdp, `document.querySelector('#navGlobalMore').click()`);
        await sleep(220);
        const menu = await evaluate(cdp, `(() => {
          const b = document.querySelector('#navGlobalMore');
          const m = document.querySelector('#globalMoreMenu');
          return {
            open: !m.hidden, expanded: b.getAttribute('aria-expanded'),
            buttons: [...m.querySelectorAll('button')].length,
          };
        })()`);
        check(`P1 ${width}×${height} ${theme}: 点击仍打开既有设置菜单`,
          menu.open && menu.expanded === 'true' && menu.buttons > 0, menu);
        await shot(`p1-settings-menu-${width}x${height}-${theme}`);
        await evaluate(cdp, `document.querySelector('#navGlobalMore').click()`);
        await sleep(150);

        /* ---------- P2 顶部会话标题 ---------- */
        await waitFor(cdp, `document.querySelectorAll('.pj-sess').length > 0`, 6000);
        const titleDebug = await evaluate(cdp, `(async () => {
          __P.S.state.sessionName = '';
          await __P.sessions.refreshSidebarSessions();
          return {
            title: document.querySelector('#title').textContent,
            sessionName: __P.S.state?.sessionName,
            current: __P.S.state?.sessionId,
            rows: [...document.querySelectorAll('.pj-sess')].map((r) => ({
              title: r.querySelector('.pj-sess-title')?.textContent,
              on: r.classList.contains('on'),
            })),
          };
        })()`);
        console.log('P2 debug: ' + JSON.stringify(titleDebug));
        await waitFor(cdp, `document.querySelector('#title').textContent === '发酵罐空气分布器设计核算'`, 5000);
        check(`P2 ${width}×${height} ${theme}: 历史会话打开时顶栏显示列表标题`,
          (await title()) === '发酵罐空气分布器设计核算', await title());
        await shot(`p2-session-title-current-${width}x${height}-${theme}`);

        await switchToHistorySession();
        check(`P2 ${width}×${height} ${theme}: 切换历史会话后顶栏显示目标标题`,
          (await title()) === '帮我把 README 的测试那节补全', await title());

        const renamed = await evaluate(cdp, `(() => {
          const row = document.querySelector('.pj-sess.on');
          if (!row) return false;
          row.querySelector('.pj-sess-menu-trigger').click();
          return true;
        })()`);
        await sleep(180);
        const renameReady = await evaluate(cdp, `(() => {
          const item = [...document.querySelectorAll('[role="menuitem"]')]
            .find((n) => n.textContent.includes('重命名'));
          if (!item) return false;
          item.click();
          return true;
        })()`);
        await sleep(180);
        const renameDone = await evaluate(cdp, `(() => {
          const input = document.querySelector('.pj-sess-input');
          if (!input) return false;
          input.value = 'README 测试补全（已改名）';
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          return true;
        })()`);
        await sleep(600);
        const renameState = await evaluate(cdp, `({
          title: document.querySelector('#title').textContent,
          row: document.querySelector('.pj-sess.on .pj-sess-title')?.textContent || '',
        })`);
        metrics.push({ scene: 'p2-rename', width, height, theme, renamed, renameReady, renameDone, ...renameState });
        check(`P2 ${width}×${height} ${theme}: 行内重命名同时更新顶栏与侧栏`,
          renamed && renameReady && renameDone
            && renameState.title === 'README 测试补全（已改名）'
            && renameState.row === 'README 测试补全（已改名）',
          { renamed, renameReady, renameDone, ...renameState,
            currentRows: await evaluate(cdp, `document.querySelectorAll('.pj-sess.on').length`),
            menuItems: await evaluate(cdp, `[...document.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent)`) });
        await shot(`p2-session-title-renamed-${width}x${height}-${theme}`);

        /* ---------- P3 上下文容量 ---------- */
        check(`P3 ${width}×${height} ${theme}: 初始 1M 容量`,
          (await usageText()) === '上下文 61.23k / 1M' && (await pctText()) === '6%', {
            note: await usageText(), pct: await pctText(),
          });
        await evaluate(cdp, `document.querySelector('#btnCtx').click()`);
        await sleep(220);
        const tip1m = await evaluate(cdp, `document.querySelector('#composerPopover').textContent`);
        check(`P3 ${width}×${height} ${theme}: 1M 浮层与侧栏同值`,
          tip1m.includes('6% 已用 (剩余 94%)') && tip1m.includes('已用 61.23k 标记, 共 1M')
            && (await usageText()).includes('/ 1M'), tip1m.slice(0, 180));
        await shot(`p3-context-1m-${width}x${height}-${theme}`);
        await evaluate(cdp, `__P.closePop()`);

        await switchModel('opencode-go', 'grok-4.7');
        const grokNote = await usageText();
        const grokPct = await pctText();
        check(`P3 ${width}×${height} ${theme}: 跨供应商切到 Grok 后容量变为 256k`,
          grokNote === '上下文 61.23k / 256k' && grokPct === '24%', { note: grokNote, pct: grokPct });
        check(`P3 ${width}×${height} ${theme}: 已用 token 不因换模型清零`,
          grokNote.startsWith('上下文 61.23k /'), grokNote);
        await evaluate(cdp, `document.querySelector('#btnCtx').click()`);
        await sleep(220);
        const tipGrok = await evaluate(cdp, `document.querySelector('#composerPopover').textContent`);
        check(`P3 ${width}×${height} ${theme}: Grok 浮层与侧栏同值（24% / 256k）`,
          tipGrok.includes('24% 已用 (剩余 76%)') && tipGrok.includes('已用 61.23k 标记, 共 256k'), tipGrok.slice(0, 180));
        await shot(`p3-context-grok-256k-${width}x${height}-${theme}`);
        await evaluate(cdp, `__P.closePop()`);

        await switchModel('deepseek', 'deepseek-v4-flash');
        check(`P3 ${width}×${height} ${theme}: 同供应商切到 Flash 后容量变为 200k`,
          (await usageText()) === '上下文 61.23k / 200k' && (await pctText()) === '31%', {
            note: await usageText(), pct: await pctText(),
          });

        await switchModel('mystery', 'mystery-model');
        const mysteryNote = await usageText();
        const mysteryPct = await pctText();
        check(`P3 ${width}×${height} ${theme}: 未提供 contextWindow 时显示未知（不沿用 200k）`,
          mysteryNote === '上下文 61.23k / 未知' && mysteryPct === '—'
            && !mysteryNote.includes('200k') && !mysteryNote.includes('1M'), { note: mysteryNote, pct: mysteryPct });
        await evaluate(cdp, `document.querySelector('#btnCtx').click()`);
        await sleep(220);
        const tipUnknown = await evaluate(cdp, `document.querySelector('#composerPopover').textContent`);
        check(`P3 ${width}×${height} ${theme}: 未知容量浮层明确说明，不显示旧容量`,
          tipUnknown.includes('容量未知（当前模型未提供 contextWindow）')
            && !tipUnknown.includes('共 200k') && !tipUnknown.includes('共 1M'), tipUnknown.slice(0, 180));
        await shot(`p3-context-unknown-${width}x${height}-${theme}`);
        await evaluate(cdp, `__P.closePop()`);

        await switchModel('deepseek', 'deepseek-v4-pro');
        check(`P3 ${width}×${height} ${theme}: 切回 Pro 后容量恢复 1M`,
          (await usageText()) === '上下文 61.23k / 1M' && (await pctText()) === '6%', {
            note: await usageText(), pct: await pctText(),
          });

        /* ---------- P2 生成速度（TPS） ---------- */
        await evaluate(cdp, `(() => {
          __P.closePop();
          __P.usage.clearSessionUsage();
          __P.S.stats = {
            contextUsage: { tokens: 61234, contextWindow: 1000000, percent: 6.1234 },
            tokens: { input: 18420, output: 3110, cacheRead: 40200 }, cost: 0.0842,
          };
          __P.usage.beginUsageTurn();
          __P.usage.onAssistantMessageStart({ type: 'message_start', message: { role: 'assistant' } }, 1000);
          __P.usage.onAssistantMessageEnd({
            type: 'message_end',
            message: { role: 'assistant', usage: { output: 450 }, stopReason: 'stop' },
          }, 11000);
          __P.usage.onTurnUsage({ input: 18420, output: 450, cacheRead: 40200 });
          __P.usage.onTurnThroughputSettled();
          __P.usage.renderUsageState();
          document.querySelector('#btnCtx').click();
          return true;
        })()`);
        await waitFor(cdp, `!!document.querySelector('#composerPopover .tip-speed-row')`, 5000);
        const tps = await evaluate(cdp, `(() => {
          const speed = document.querySelector('#composerPopover .tip-speed');
          return { text: speed?.textContent, title: speed?.title || '',
            row: document.querySelector('#composerPopover .tip-speed-row')?.textContent || '' };
        })()`);
        check(`P2 ${width}×${height} ${theme}: 最近一轮显示实测生成速度`,
          tps.text === '45 tokens/s' && tps.row.includes('生成速度')
            && tps.title.includes('450') && tps.title.includes('10.0'), tps);
        await shot(`p2-tps-context-${width}x${height}-${theme}`);
        await evaluate(cdp, `__P.closePop()`);

        await evaluate(cdp, `(() => {
          __P.usage.clearSessionUsage();
          __P.S.stats = {
            contextUsage: { tokens: 61234, contextWindow: 1000000, percent: 6.1234 },
            tokens: { input: 18420, output: 3110, cacheRead: 40200 }, cost: 0.0842,
          };
          __P.usage.beginUsageTurn();
          __P.usage.onTurnThroughputSettled();
          __P.usage.onTurnUsage({ input: 1200, output: 300 });
          __P.usage.renderUsageState();
          document.querySelector('#btnCtx').click();
          return true;
        })()`);
        await waitFor(cdp, `!!document.querySelector('#composerPopover .tip-speed-row')`, 5000);
        const tpsMissing = await evaluate(cdp, `document.querySelector('#composerPopover .tip-speed')?.textContent`);
        check(`P2 ${width}×${height} ${theme}: 缺少响应时间时显示 —，不编造速度`,
          tpsMissing === '—', tpsMissing);
        await shot(`p2-tps-unavailable-${width}x${height}-${theme}`);
        await evaluate(cdp, `__P.closePop()`);

        /* ---------- P4 模型 + 思考统一菜单 ---------- */
        await fetch(new URL('/api/__composer-models', url), { method: 'POST' });
        await waitFor(cdp, `(__P.S.models || []).some((m) => (m.providerId || m.provider) === 'zhipu')
          && (__P.S.models || []).filter((m) => (m.providerId || m.provider) === 'openrouter').length >= 100`, 8000);
        /* 从确定的空「最近使用」开始，截图才可复核。 */
        await evaluate(cdp, `(() => { localStorage.removeItem('pi-gui.recent-models.v1'); __P.closePop(); document.querySelector('#btnModel').click(); return true; })()`);
        await waitFor(cdp, `!document.querySelector('#composerPopover').hidden
          && document.querySelector('#composerPopover').classList.contains('model-menu')`, 5000);
        const menuMetrics = await evaluate(cdp, `(() => {
          const pop = document.querySelector('#composerPopover');
          const list = pop.querySelector('.model-pane-list');
          const rect = pop.getBoundingClientRect();
          const composer = document.querySelector('#chatComposer').getBoundingClientRect();
          return {
            rect: [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height],
            composerTop: composer.top, vw: innerWidth, vh: innerHeight,
            scroll: [pop.scrollWidth, pop.clientWidth],
            listScroll: [list.scrollWidth, list.clientWidth],
            rails: [...pop.querySelectorAll('.model-rail-item')].map((n) => ({
              name: n.querySelector('.model-rail-name').textContent,
              count: n.querySelector('.model-rail-count').textContent,
              on: n.classList.contains('on'),
            })),
            current: document.querySelector('.ui3-model-item.on')?.dataset.modelId || '',
            active: document.activeElement?.dataset?.modelId || document.activeElement?.className || '',
            roving: [...pop.querySelectorAll('.ui3-model-item, .model-rail-item')].filter((n) => n.tabIndex === 0).length,
            search: Boolean(pop.querySelector('.ui3-model-search')),
            title: pop.querySelector('.model-pane-title')?.textContent || '',
          };
        })()`);
        metrics.push({ scene: 'p4-menu', width, height, theme, ...menuMetrics });
        check(`P4 ${width}×${height} ${theme}: 两栏菜单在 Composer 上方且不溢出视口`,
          menuMetrics.rect[0] >= 7 && menuMetrics.rect[2] <= menuMetrics.vw - 7 && menuMetrics.rect[3] <= menuMetrics.composerTop - 4
            && menuMetrics.rect[4] <= 420.5 && menuMetrics.rect[4] >= 300 && menuMetrics.scroll[0] <= menuMetrics.scroll[1] + 1
            && menuMetrics.listScroll[0] <= menuMetrics.listScroll[1] + 1, menuMetrics);
        check(`P4 ${width}×${height} ${theme}: 左栏为最近使用 + 供应商与计数`,
          menuMetrics.rails.map((r) => r.name).join(',') === '最近使用,deepseek,zhipu,openrouter'
            && menuMetrics.rails.map((r) => r.count).join(',') === '1,2,1,100', menuMetrics.rails);
        check(`P4 ${width}×${height} ${theme}: 当前模型行获得焦点且 roving 唯一`,
          menuMetrics.current === 'deepseek-v4-pro' && menuMetrics.active === 'deepseek-v4-pro' && menuMetrics.roving === 1,
          { current: menuMetrics.current, active: menuMetrics.active, roving: menuMetrics.roving });
        check(`P4 ${width}×${height} ${theme}: 顶部搜索与底部滑杆同时在场`,
          menuMetrics.search && await evaluate(cdp, `!!document.querySelector('#composerPopover .model-thinking-range')`));
        await shot(`p4-model-menu-${width}x${height}-${theme}`);

        await evaluate(cdp, `(() => {
          __P.picker.rememberRecentModel('openrouter', 'router-0-' + 'long-model-id-'.repeat(12));
          __P.picker.rememberRecentModel('zhipu', 'glm');
          __P.closePop();
          document.querySelector('#btnModel').click();
          return true;
        })()`);
        await waitFor(cdp, `document.querySelector('#composerPopover .model-pane-title')?.textContent === '最近使用'`, 5000);
        const recent = await evaluate(cdp, `(() => {
          const rows = [...document.querySelectorAll('#composerPopover .ui3-model-item')];
          return rows.map((n) => n.dataset.provider + '/' + n.dataset.modelId);
        })()`);
        check(`P4 ${width}×${height} ${theme}: 最近使用跨供应商且当前项在首位`,
          recent.length === 3 && recent[0] === 'deepseek/deepseek-v4-pro'
            && recent.some((row) => row.startsWith('openrouter/router-0-')) && recent.includes('zhipu/glm'), recent);
        await shot(`p4-recent-models-${width}x${height}-${theme}`);

        await evaluate(cdp, `(() => {
          [...document.querySelectorAll('#composerPopover .model-rail-item')]
            .find((n) => n.dataset.section === 'provider:openrouter').click();
          return true;
        })()`);
        await waitFor(cdp, `document.querySelector('#composerPopover .model-pane-title')?.textContent === 'openrouter'`, 5000);
        const many = await evaluate(cdp, `(() => {
          const pop = document.querySelector('#composerPopover');
          const rows = [...pop.querySelectorAll('.ui3-model-item')];
          const list = pop.querySelector('.model-pane-list').getBoundingClientRect();
          const text = rows[0]?.querySelector('.pi-text');
          const rect = text?.getBoundingClientRect();
          return {
            count: rows.length,
            ellipsis: text ? getComputedStyle(text).textOverflow : '',
            truncated: text ? text.scrollWidth > text.clientWidth : false,
            inside: rect ? rect.right <= list.right + 1 : false,
            paneCount: pop.querySelector('.model-pane-count')?.textContent,
          };
        })()`);
        check(`P4 ${width}×${height} ${theme}: 100 个同 Provider 模型可滚动且长名截断`,
          many.count === 100 && many.paneCount === '100' && many.ellipsis === 'ellipsis'
            && many.inside, many);
        await shot(`p4-multi-provider-${width}x${height}-${theme}`);

        await evaluate(cdp, `(() => {
          const input = document.querySelector('#composerPopover .ui3-model-search');
          input.focus();
          input.value = 'router-42';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`);
        await waitFor(cdp, `document.querySelector('#composerPopover .model-pane-title')?.textContent === '搜索结果'`, 5000);
        const search = await evaluate(cdp, `(() => {
          const pop = document.querySelector('#composerPopover');
          return {
            count: pop.querySelectorAll('.ui3-model-item').length,
            paneCount: pop.querySelector('.model-pane-count')?.textContent,
            railCount: pop.querySelector('.model-rail-count')?.textContent,
            group: [...pop.querySelectorAll('.model-group-label')].map((n) => n.textContent),
            active: document.activeElement === pop.querySelector('.ui3-model-search'),
            overflow: pop.scrollWidth <= pop.clientWidth + 1,
          };
        })()`);
        check(`P4 ${width}×${height} ${theme}: 搜索跨供应商、显示匹配数并保持焦点`,
          search.count === 1 && search.paneCount === '1' && search.railCount === '1'
            && search.group.join(',') === 'openrouter' && search.active && search.overflow, search);
        await shot(`p4-search-${width}x${height}-${theme}`);

        await evaluate(cdp, `(() => {
          const input = document.querySelector('#composerPopover .ui3-model-search');
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`);
        await switchModel('zhipu', 'glm');
        /* switchModel 在回读后收起菜单；验收要重新打开同一份统一菜单。 */
        await evaluate(cdp, `document.querySelector('#btnModel').click()`);
        await waitFor(cdp, `!document.querySelector('#composerPopover').hidden
          && document.querySelector('#composerPopover').classList.contains('model-menu')`, 5000);
        const thinking = await evaluate(cdp, `(() => {
          const pop = document.querySelector('#composerPopover');
          const slider = pop.querySelector('.model-thinking-slider');
          const menuRect = pop.getBoundingClientRect();
          const sr = slider?.getBoundingClientRect();
          return {
            levels: [...pop.querySelectorAll('.ui3-think-item')].map((n) => n.dataset.level),
            on: pop.querySelector('.ui3-think-item.on')?.dataset.level || '',
            range: pop.querySelector('.model-thinking-range')?.value,
            valueText: pop.querySelector('.model-thinking-range')?.getAttribute('aria-valuetext'),
            inside: sr ? sr.bottom <= menuRect.bottom + 1 && sr.width > 100 : false,
            ticks: [...pop.querySelectorAll('.ui3-think-item')].map((n) => n.getBoundingClientRect().width),
          };
        })()`);
        check(`P4 ${width}×${height} ${theme}: 思考滑杆档位来自 Pi 且当前项一致`,
          thinking.levels.join(',') === 'off,low,medium,high' && thinking.on === 'medium'
            && thinking.range === '2' && thinking.valueText === 'medium' && thinking.inside, thinking);
        check(`P4 ${width}×${height} ${theme}: 分段等宽且没有溢出`,
          new Set(thinking.ticks.map((t) => Math.round(t))).size === 1
            && thinking.ticks.every((t) => t > 0), thinking.ticks);
        await shot(`p4-thinking-slider-${width}x${height}-${theme}`);

        await switchModel('deepseek', 'deepseek-v4-pro');
        await evaluate(cdp, `__P.closePop()`);

        /* ---------- P3 欢迎吉祥物（无内容 ready 态） ---------- */
        await evaluate(cdp, `(() => {
          __P.S.thread.innerHTML = '';
          __P.S.thread.removeAttribute('aria-busy');
          __P.messages.syncWelcome();
          return true;
        })()`);
        await waitFor(cdp, `!document.querySelector('#welcome').hidden
          && !document.querySelector('#welcomeReady').hidden
          && !!document.querySelector('#welcomeReady .welcome-mascot')`, 5000);
        const mascot = await evaluate(cdp, `(() => {
          const svg = document.querySelector('#welcomeReady .welcome-mascot');
          const r = svg.getBoundingClientRect();
          const float = svg.querySelector('.mascot-float');
          const line = svg.querySelector('.mascot-line');
          return {
            rect: [r.width, r.height],
            viewBox: svg.getAttribute('viewBox'),
            anim: getComputedStyle(float).animationName,
            duration: getComputedStyle(float).animationDuration,
            stroke: getComputedStyle(line).stroke,
            external: svg.querySelectorAll('image, use, script, foreignObject').length,
            inRestore: Boolean(document.querySelector('#welcomeRestore .welcome-mascot')),
            hover: getComputedStyle(svg).transitionProperty,
          };
        })()`);
        metrics.push({ scene: 'p3-mascot', width, height, theme, ...mascot });
        check(`P3 ${width}×${height} ${theme}: 欢迎页吉祥物 100×100 且只在 ready 态`,
          Math.abs(mascot.rect[0] - 100) < 0.6 && Math.abs(mascot.rect[1] - 100) < 0.6
            && mascot.viewBox === '0 0 100 100' && !mascot.inRestore, mascot);
        check(`P3 ${width}×${height} ${theme}: 线稿动画在跑、无外链资源`,
          mascot.anim === 'mascot-float' && mascot.duration !== '0s'
            && mascot.external === 0 && mascot.stroke !== 'none', mascot);
        await shot(`p3-welcome-mascot-${width}x${height}-${theme}`);

        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        await sleep(240);
        const reduced = await evaluate(cdp, `(() => {
          const svg = document.querySelector('#welcomeReady .welcome-mascot');
          return {
            float: getComputedStyle(svg.querySelector('.mascot-float')).animationName,
            eye: getComputedStyle(svg.querySelector('.mascot-eye')).animationName,
            antenna: getComputedStyle(svg.querySelector('.mascot-antenna-dot')).animationName,
          };
        })()`);
        check(`P3 ${width}×${height} ${theme}: prefers-reduced-motion 下全部动画停止`,
          reduced.float === 'none' && reduced.eye === 'none' && reduced.antenna === 'none', reduced);
        await shot(`p3-welcome-mascot-reduced-${width}x${height}-${theme}`);
        await cdp.send('Emulation.setEmulatedMedia', { features: [] });
        await sleep(160);
        /* 恢复夹具模型清单，下一轮 P3 仍要看到 Grok / Mystery。 */
        await fetch(new URL('/api/__composer-reset', url), { method: 'POST' });
        await sleep(220);
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
  const passed = assertions.filter((item) => item.pass).length;
  console.log(`P1–P3 shots: ${passed}/${assertions.length}`);
  if (cdp.pageErrors.length) console.log('页面错误: ' + JSON.stringify(cdp.pageErrors));
  if (passed !== assertions.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
