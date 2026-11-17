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
    const [state, usage, sessions, theme, popover] = await Promise.all([
      import('/state.js'), import('/usage.js'), import('/sessions.js'), import('/theme.js'), import('/ui/popover.js'),
    ]);
    Object.assign(window.__P, { S: state.S, usage, sessions, theme, closePop: popover.closePop });
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
          const svg = button.querySelector('svg[data-icon="slidersHorizontal"]');
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
        check(`P1 ${width}×${height} ${theme}: 设置入口渲染 sliders-horizontal`,
          icon.icon && icon.paths === 1 && icon.circles === 0, icon);
        check(`P1 ${width}×${height} ${theme}: 图标 18×18、按钮 28×28（既有角色尺寸）`,
          Math.abs(icon.svg?.[0] - 18) < 0.6 && Math.abs(icon.svg?.[1] - 18) < 0.6
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
