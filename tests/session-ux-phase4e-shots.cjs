/* P4-E：后台会话终态提示的真实 Chromium 验收。
 *
 * 用法：node tests/session-ux-phase4e-shots.cjs
 * 产物：docs/ui/session-ux-phase4e-evidence/
 *
 * 只使用产品模块与产品 CSS：注入的是 fixture 数据（不启 Pi、不读用户会话、
 * 不发网络请求）。覆盖 1320×820 与 700×600、深色与浅色、侧栏聚合提示与
 * 既有 Runtime 列表，并测量横向溢出、点击目标与文字对比度。
 */
'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'ui', 'session-ux-phase4e-evidence');
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ux-p4e-'));
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
    await sleep(180);
  };
  const setViewport = async (width, height) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(240);
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

    await evalJs(`(async () => {
      window.__RS = await import('/runtime-state.js');
      window.__RN = await import('/runtime-nav.js');
      window.__RSN = await import('/runtime-sessions.js');
      window.__MODAL = await import('/ui/modal.js');

      /* Chrome 对 color-mix() 会返回 oklab(...) / color(...)，正则解析不到。
       * 用 1×1 canvas 让浏览器自己把任意合法 CSS 颜色落成 sRGB。 */
      const paint = document.createElement('canvas');
      paint.width = paint.height = 1;
      const paintCtx = paint.getContext('2d', { willReadFrequently: true });
      const parseColor = (value) => {
        const text = String(value || '').trim();
        if (!text) return null;
        paintCtx.clearRect(0, 0, 1, 1);
        paintCtx.fillStyle = text;
        paintCtx.fillRect(0, 0, 1, 1);
        const data = paintCtx.getImageData(0, 0, 1, 1).data;
        return [data[0], data[1], data[2], data[3] / 255];
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
        return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
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

      const owner = (id) => ({ backendInstance: 'p4e-backend', projectId: 'p4e-project', repoId: 'p4e-repo',
        workspaceId: 'p4e-ws-' + id, workspaceEpoch: 'p4e-epoch', conversationId: id,
        runtimeId: 'p4e-rt-' + id, runtimeGeneration: 'p4e-gen', sessionId: 'p4e-native-' + id });
      const item = (id, branch, createdAt, kind, reason, extra = {}) => ({
        conversationId: id, kind: 'project', createdAt, revision: extra.revision,
        workspace: { branch, cwd: '/p4e-fixture', projectId: 'p4e-project' },
        title: branch, nativeSessionId: 'p4e-native-' + id, sessionName: null,
        owner: owner(id), lifecycle: 'ready', activity: 'idle', attention: true, focused: false,
        historyRequired: false, error: extra.error || null, stop: null,
        outcome: { kind, reason, sequence: 1 },
      });
      const items = [
        item('p4e-completed', 'feat/background-completion', '2026-11-16T01:00:00.000Z', 'completed', 'generation_completed', { revision: 10 }),
        item('p4e-failed', 'fix/runtime-crash-on-start', '2026-11-16T01:01:00.000Z', 'failed', 'generation_failed', { revision: 11, error: 'generation_failed' }),
        item('p4e-interrupted', 'feat/session-pagination', '2026-11-16T01:02:00.000Z', 'interrupted', 'user_cancelled', { revision: 12 }),
        item('p4e-unknown', 'chore/long-history-cleanup', '2026-11-16T01:03:00.000Z', 'unknown', 'unconfirmed', { revision: 13 }),
      ];
      window.__p4eItems = items;
      const realFetch = window.fetch.bind(window);
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      window.fetch = (input, init = {}) => {
        const target = String(input);
        if (target.includes('/api/worktrees')) return Promise.resolve(json({ ok: true, projectId: 'p4e-project', contextGeneration: 1, items: [] }));
        if (target.includes('/api/runtime-sessions')) {
          if (init?.method === 'POST') return Promise.resolve(json({ ok: true }));
          return Promise.resolve(json({ ok: true, backendInstance: 'p4e-backend', liveCount: 4, totalCount: 4, limit: 2, hardLimit: 3, items: window.__p4eItems }));
        }
        return realFetch(input, init);
      };

      window.__p4e = {
        contrast, px, rect, overflow, style,
        async seed() {
          const side = document.getElementById('projectSidebar');
          side.hidden = false;
          document.querySelector('.app')?.classList.remove('sidebar-collapsed');
          const projects = document.getElementById('projects');
          projects.replaceChildren();
          const project = document.createElement('div');
          project.className = 'project active';
          project.innerHTML = '<span class="pj-icon"><svg aria-hidden="true"></svg></span><span class="pj-name">p4e-fixture</span>';
          const box = document.createElement('div');
          box.className = 'pj-sessions';
          box.id = 'p4eSessions';
          projects.append(project, box);
          await __RN.loadRuntimeNav({ path: '/p4e-fixture' }, { parent: box });
          await new Promise((resolve) => setTimeout(resolve, 280));
          return { rows: box.querySelectorAll('.pj-runtime[data-conversation-id]').length, results: box.querySelectorAll('.pj-runtime-results').length };
        },
        measureSidebar() {
          const side = document.getElementById('projectSidebar');
          const box = document.getElementById('p4eSessions');
          const list = document.getElementById('pjRuntimeList');
          const result = list?.querySelector('.pj-runtime-results');
          const rows = [...(list?.querySelectorAll('.pj-runtime[data-conversation-id]') || [])];
          const rowData = rows.map((row) => {
            const status = row.querySelector('.pj-runtime-status');
            const dot = row.querySelector('.pj-runtime-dot');
            return {
              conversationId: row.dataset.conversationId, outcome: row.dataset.outcome || null,
              status: status?.textContent || '', statusClass: status?.className || '',
              statusColor: style(status, ['color', 'fontSize', 'lineHeight']),
              dotColor: style(dot, ['backgroundColor', 'boxShadow']),
              contrast: contrast(status),
              overflow: { row: overflow(row), status: overflow(status) },
              rowHeight: rect(row)?.height ?? null,
            };
          });
          return {
            viewport: [innerWidth, innerHeight], theme: document.documentElement.dataset.theme || '',
            sidebar: { ...rect(side), overflow: overflow(side) },
            list: { ...rect(list), overflow: overflow(list) },
            results: {
              count: list?.querySelectorAll('.pj-runtime-results').length || 0,
              text: result?.textContent || '', aria: result?.getAttribute('aria-label') || '',
              ...rect(result), overflow: overflow(result), contrast: contrast(result),
              fontSize: style(result, ['fontSize', 'lineHeight']),
            },
            rows: rowData,
            rowCount: rows.length,
            documentOverflow: document.documentElement.scrollWidth - innerWidth,
          };
        },
        async openResults() {
          document.querySelector('.pj-runtime-results')?.click();
          for (let i = 0; i < 60; i++) {
            if (document.querySelector('#modal:not([hidden]) .runtime-list [data-conversation-id]')) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await new Promise((resolve) => setTimeout(resolve, 180));
          return true;
        },
        measureResults() {
          const modal = document.getElementById('modal');
          const card = document.getElementById('modalCard');
          const layout = card?.querySelector('.runtime-layout');
          const buttons = [...(card?.querySelectorAll('.runtime-list [data-conversation-id]') || [])];
          const selected = buttons.find((button) => button.getAttribute('aria-pressed') === 'true');
          const state = card?.querySelector('.runtime-body .modal-desc');
          return {
            viewport: [innerWidth, innerHeight], theme: document.documentElement.dataset.theme || '',
            open: modal?.hidden === false,
            card: { ...rect(card), overflow: overflow(card) },
            layout: { ...rect(layout), overflow: overflow(layout) },
            list: { ...rect(card?.querySelector('.runtime-list')), overflow: overflow(card?.querySelector('.runtime-list')) },
            buttons: buttons.map((button) => ({
              conversationId: button.dataset.conversationId, outcome: button.dataset.outcome || null,
              text: button.textContent, pressed: button.getAttribute('aria-pressed') === 'true', overflow: overflow(button),
            })),
            selected: selected?.dataset.conversationId || null,
            state: state?.textContent || '',
            documentOverflow: document.documentElement.scrollWidth - innerWidth,
            runtimeHidden: document.getElementById('runtimeView')?.hidden ?? null,
          };
        },
        closeResults() { __MODAL.closeModal(); return true; },
      };
      return true;
    })()`);

    const seeded = await evalJs('__p4e.seed()');
    record('seed', seeded);
    check('seed-shape', seeded.rows === 4 && seeded.results === 1, seeded);

    /* 键盘焦点：先给页面一次 Tab，程序化聚焦才会匹配 :focus-visible。 */
    const tabKey = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...tabKey });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...tabKey });

    const matrix = [
      { theme: 'dark', width: 1320, height: 820, label: 'dark-1320' },
      { theme: 'light', width: 1320, height: 820, label: 'light-1320' },
      { theme: 'dark', width: 700, height: 600, label: 'dark-700' },
      { theme: 'light', width: 700, height: 600, label: 'light-700' },
    ];

    for (const entry of matrix) {
      await setTheme(entry.theme);
      await setViewport(entry.width, entry.height);
      const measured = await evalJs('__p4e.measureSidebar()');
      record('sidebar-' + entry.label, measured);
      await shot('sidebar-' + entry.label);

      check('sidebar-one-aggregate-' + entry.label, measured.results.count === 1
        && measured.results.text.includes('4 个后台会话有结果'), measured.results);
      check('sidebar-four-terminal-states-' + entry.label,
        measured.rows.map((row) => row.outcome).join(',') === 'completed,failed,interrupted,unknown'
        && measured.rows.map((row) => row.status).join(',') === '已完成,失败,已中断,已结束',
        measured.rows);
      check('sidebar-no-overflow-' + entry.label,
        measured.documentOverflow === 0 && measured.sidebar.overflow === 0 && measured.list.overflow === 0
        && measured.results.overflow === 0 && measured.rows.every((row) => row.overflow.row === 0 && row.overflow.status === 0),
        { documentOverflow: measured.documentOverflow, sidebar: measured.sidebar.overflow, list: measured.list.overflow, results: measured.results.overflow, rows: measured.rows.map((row) => row.overflow) });
      check('sidebar-target-size-' + entry.label, measured.results.height >= 28, measured.results);
      check('sidebar-contrast-' + entry.label,
        measured.results.contrast >= 4.5 && measured.rows.every((row) => row.contrast >= 4.5),
        { results: measured.results.contrast, rows: measured.rows.map((row) => [row.outcome, row.contrast]) });

      if (entry.width === 1320) {
        const focus = await evalJs(`(() => {
          const button = document.querySelector('.pj-runtime-results');
          button?.focus();
          const cs = button ? getComputedStyle(button) : null;
          return { focused: document.activeElement === button, focusVisible: button?.matches(':focus-visible') || false,
            outlineStyle: cs?.outlineStyle || '', outlineWidth: cs?.outlineWidth || '' };
        })()`);
        record('aggregate-focus-' + entry.label, focus);
        check('aggregate-focus-visible-' + entry.label,
          focus.focused && focus.focusVisible && focus.outlineStyle === 'solid' && focus.outlineWidth === '2px', focus);

        const before = await evalJs(`({ runtimeHidden: document.getElementById('runtimeView')?.hidden ?? null })`);
        await evalJs('__p4e.openResults()');
        const results = await evalJs('__p4e.measureResults()');
        record('results-' + entry.label, results);
        await shot('results-' + entry.label);
        check('results-open-' + entry.label, results.open && results.buttons.length === 4, results);
        check('results-labels-' + entry.label,
          results.buttons.map((button) => button.outcome).join(',') === 'completed,failed,interrupted,unknown'
          && results.buttons.map((button) => button.text).join('|').includes('已完成')
          && results.buttons.map((button) => button.text).join('|').includes('失败')
          && results.buttons.map((button) => button.text).join('|').includes('已中断')
          && results.buttons.map((button) => button.text).join('|').includes('已结束'), results.buttons);
        check('results-preselect-latest-' + entry.label, results.selected === 'p4e-unknown', results.selected);
        check('results-state-label-' + entry.label, results.state.includes('已结束') && results.state.includes('未确认') === false, results.state);
        check('results-no-overflow-' + entry.label,
          results.documentOverflow === 0 && results.card.overflow === 0 && results.layout.overflow === 0
          && results.list.overflow === 0 && results.buttons.every((button) => button.overflow === 0),
          { document: results.documentOverflow, card: results.card.overflow, layout: results.layout.overflow, list: results.list.overflow, buttons: results.buttons.map((button) => button.overflow) });
        check('results-do-not-switch-' + entry.label, results.runtimeHidden === before.runtimeHidden, { before, after: results.runtimeHidden });
        await evalJs('__p4e.closeResults()');
        await sleep(180);
      }
    }

    /* 窄窗也打开既有列表：验证单列布局、行文字与终端态标签。 */
    for (const entry of matrix.filter((item) => item.width === 700)) {
      await setTheme(entry.theme);
      await setViewport(entry.width, entry.height);
      await evalJs('__p4e.openResults()');
      const results = await evalJs('__p4e.measureResults()');
      record('results-' + entry.label, results);
      await shot('results-' + entry.label);
      check('results-narrow-open-' + entry.label, results.open && results.buttons.length === 4, results);
      check('results-narrow-selected-' + entry.label, results.selected === 'p4e-unknown', results.selected);
      check('results-narrow-no-overflow-' + entry.label,
        results.documentOverflow === 0 && results.card.overflow === 0 && results.layout.overflow === 0
        && results.buttons.every((button) => button.overflow === 0),
        { document: results.documentOverflow, card: results.card.overflow, layout: results.layout.overflow, buttons: results.buttons.map((button) => button.overflow) });
      check('results-narrow-state-' + entry.label, results.state.includes('已结束'), results.state);
      await evalJs('__p4e.closeResults()');
      await sleep(180);
    }

    const failed = assertions.filter((item) => !item.pass);
    fs.writeFileSync(path.join(OUT, 'measurements.json'), JSON.stringify({
      browser: CHROME,
      viewports: [[1320, 820], [700, 600]],
      themes: ['dark', 'light'],
      assertions, failures: failed, metrics,
    }, null, 2));
    console.log('\n断言: ' + (assertions.length - failed.length) + '/' + assertions.length + ' 通过');
    console.log('视觉证据写入: ' + path.join(OUT, 'measurements.json'));
    if (failed.length) throw new Error('P4-E 视觉验收有 ' + failed.length + ' 条断言失败');
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
    try { harness.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
