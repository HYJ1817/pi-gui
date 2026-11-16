/* P4-B 真实 Chromium 验收：错误块内的恢复入口、状态与窄屏布局。
 *
 * 用法：node tests/session-ux-phase4b-shots.cjs
 * 产物：docs/ui/session-ux-phase4bc-evidence/p4b/
 * 固定夹具；不启动真 pi、不读用户会话、不写用户数据。
 */
'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'ui', 'session-ux-phase4bc-evidence', 'p4b');
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ux-p4b-'));
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

const CONTRAST_HELPER = `
  function parseColor(value) {
    const match = /^rgba?\\(([^)]+)\\)$/.exec(String(value || '').trim());
    if (!match) return null;
    const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  }
  function effectiveBackground(node) {
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
  }
  function channel(value) {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function luminance(rgb) {
    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  }
  function contrast(node) {
    const fg = parseColor(getComputedStyle(node).color);
    const bg = effectiveBackground(node);
    if (!fg) return null;
    const blended = [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    const a = luminance(blended), b = luminance(bg);
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  }
`;

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
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 800));
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
      window.__surface = await import('/ui/workspace-surface.js');
      window.__S = (await import('/state.js')).S;
      window.__M = await import('/messages.js');
      window.__R = await import('/error-recovery.js');
      Object.assign(__S, {
        hasProject: true, bridgeState: 'ready', bridgeRun: 1, cwd: 'p4b-fixture',
        streaming: false, stopping: false, switching: false, fallbackActive: false, modelSwitchPending: false,
      });
      __S.models = [{ providerId: 'fixture', modelId: 'model-alpha' }, { providerId: 'fixture', modelId: 'model-beta' }];
      __S.state = { model: { providerId: 'fixture', modelId: 'model-alpha' }, sessionId: 'p4b-session', sessionFile: null, thinkingLevel: 'off' };
      __surface.showChat();
      return true;
    })()`);
    await sleep(250);

    const render = async (kind, raw, runKind = 'success') => {
      await evalJs(`(async () => {
        const text = (value) => ({ type: 'text', text: value });
        const messages = [
          { role: 'user', content: [text('请检查这个模型的配置。This turn keeps a normal assistant reply before the error.')] },
          { role: 'assistant', timestamp: 1000, stopReason: 'stop', content: [text('我先核对当前模型的认证与可用性。')] },
          { role: 'user', content: [text('继续。')] },
          { role: 'assistant', timestamp: 1200, stopReason: 'error', errorMessage: ${JSON.stringify(raw)}, content: [] },
        ];
        __M.rebuildFromMessages(messages, 'p4b-session');
        const failure = ${kind === 'auth'
          ? "{ class: 'auth_error', retryable: false, reason: '当前模型认证失败，自动备用未执行', source: 'pi-assistant', statusCode: 401 }"
          : "{ class: 'model_unavailable', retryable: true, reason: '当前模型不可用', source: 'pi-assistant', statusCode: 404 }"};
        window.__beforeRaw = document.querySelector('#stream .me-raw')?.textContent || '';
        window.__box = __M.attachErrorRecovery(__R.recoveryForFailure(failure), {
          run: async () => { return ${runKind === 'failure'
            ? "{ ok: false, message: '设置没有打开，请重试。' }"
            : "{ ok: true, message: " + JSON.stringify(kind === 'auth' ? '已打开供应商认证。' : '已打开模型列表。') + " }"}; },
        });
        document.querySelector('#stream .msg-err')?.scrollIntoView({ block: 'center' });
        return Boolean(window.__box);
      })()`);
      await sleep(260);
    };

    const measure = () => evalJs(`(() => {
      ${CONTRAST_HELPER}
      const err = document.querySelector('#stream .msg-err');
      const box = err?.querySelector('.me-actions');
      const btn = box?.querySelector('.me-action');
      const status = box?.querySelector('.me-action-status');
      const raw = err?.querySelector('.me-raw');
      const stream = document.querySelector('#stream');
      const cs = btn ? getComputedStyle(btn) : null;
      const errRect = err?.getBoundingClientRect();
      const rawRect = raw?.getBoundingClientRect();
      const boxRect = box?.getBoundingClientRect();
      const btnRect = btn?.getBoundingClientRect();
      return {
        viewport: [innerWidth, innerHeight],
        overflow: {
          document: document.documentElement.scrollWidth - innerWidth,
          stream: stream ? stream.scrollWidth - stream.clientWidth : null,
          error: err ? err.scrollWidth - err.clientWidth : null,
          actions: box ? box.scrollWidth - box.clientWidth : null,
        },
        error: {
          width: errRect?.width ?? null,
          background: err ? getComputedStyle(err).backgroundColor : null,
          border: err ? getComputedStyle(err).borderTopWidth : null,
          rawText: raw?.textContent || '',
          rawVisible: Boolean(rawRect && rawRect.height > 0),
        },
        actions: {
          count: box?.querySelectorAll('button').length || 0,
          gapAfterRaw: rawRect && boxRect ? Math.round(boxRect.top - rawRect.bottom) : null,
          buttonHeight: btnRect?.height ?? null,
          buttonWidth: btnRect?.width ?? null,
          buttonText: btn?.textContent || '',
          buttonTitle: btn?.title || '',
          buttonClass: btn?.className || '',
          buttonBusy: btn?.getAttribute('aria-busy') || null,
          buttonDisabled: btn?.disabled === true,
          buttonColor: cs?.color || null,
          buttonContrast: btn ? contrast(btn) : null,
          statusText: status?.textContent || '',
          statusState: status?.dataset.state || null,
          statusRole: status?.getAttribute('role') || null,
          statusLive: status?.getAttribute('aria-live') || null,
          statusContrast: status ? contrast(status) : null,
          focused: document.activeElement === btn,
          focusVisible: btn ? btn.matches(':focus-visible') : null,
          outline: btn ? { style: getComputedStyle(btn).outlineStyle, width: getComputedStyle(btn).outlineWidth } : null,
        },
      };
    })()`);

    const clickAction = async () => {
      await evalJs(`(() => { const btn = document.querySelector('#stream .me-action'); btn?.focus(); btn?.click(); return true; })()`);
      await sleep(240);
    };

    const key = async (keyName, code, modifiers = 0) => {
      const vk = keyName === 'Tab' ? 9 : 0;
      const params = { key: keyName, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
      await sleep(60);
    };
    /* 用真实键盘从输入区向前找恢复按钮，确保 :focus-visible 是真实键盘态。 */
    const focusActionByKeyboard = async () => {
      await evalJs(`document.getElementById('btnModel').focus(); true`);
      for (let i = 0; i < 80; i++) {
        await key('Tab', 'Tab', 8);
        if (await evalJs(`document.activeElement?.classList?.contains('me-action') === true`)) return true;
      }
      return false;
    };

    /* 1. 深色宽屏：认证错误 + 动作 */
    await setTheme('dark');
    await setViewport(1320, 820);
    await render('auth', '当前模型认证失败，自动备用未执行', 'success');
    await shot('01-auth-dark-1320');
    let m = await measure();
    record('auth-wide-dark', m);
    check('auth-wide-action-once', m.actions.count === 1, m.actions);
    check('auth-wide-compact', m.actions.buttonHeight != null && m.actions.buttonHeight <= 28, m.actions);
    check('auth-wide-near-error', m.actions.gapAfterRaw != null && m.actions.gapAfterRaw <= 12, m.actions);
    check('auth-wide-no-red-card', m.error.background === 'rgba(0, 0, 0, 0)' && m.error.border === '0px', m.error);
    check('auth-wide-no-overflow', m.overflow.document === 0 && m.overflow.stream === 0 && m.overflow.error === 0, m.overflow);

    await clickAction();
    const keyboardFocused = await focusActionByKeyboard();
    m = await measure();
    record('auth-wide-success', { ...m, keyboardFocused });
    check('auth-wide-success-text', m.actions.statusText === '已打开供应商认证。' && m.actions.statusState === 'success', m.actions);
    check('auth-wide-raw-kept', m.error.rawVisible && m.error.rawText === await evalJs('window.__beforeRaw'), m.error);
    check('auth-wide-focus-visible', keyboardFocused && m.actions.focused && m.actions.focusVisible && m.actions.outline.style !== 'none', m.actions);
    check('auth-wide-contrast', m.actions.buttonContrast >= 4.5 && m.actions.statusContrast >= 4.5, m.actions);
    await shot('02-auth-success-dark-1320');

    /* 2. 浅色宽屏：模型错误 + 动作 */
    await setTheme('light');
    await setViewport(1320, 820);
    await render('model', '当前模型不可用，自动备用未执行', 'success');
    await shot('03-model-light-1320');
    m = await measure();
    record('model-wide-light', m);
    check('model-wide-action', m.actions.buttonText === '选择其他模型' && m.actions.count === 1, m.actions);
    check('model-wide-contrast', m.actions.buttonContrast >= 4.5 && m.actions.statusContrast >= 4.5, m.actions);
    await clickAction();
    m = await measure();
    check('model-wide-success-text', m.actions.statusText === '已打开模型列表。', m.actions);
    await shot('04-model-success-light-1320');

    /* 3. 700px 深色：失败状态、长原文与动作换行 */
    await setTheme('dark');
    await setViewport(700, 600);
    const longRaw = '当前模型认证失败，自动备用未执行。请检查供应商认证状态与 API Key 是否仍然有效；如果刚刚更换了账号，请重新完成登录后再发送请求。';
    await render('auth', longRaw, 'failure');
    await shot('05-auth-dark-700');
    m = await measure();
    record('auth-narrow-dark', m);
    check('auth-narrow-action-once', m.actions.count === 1, m.actions);
    check('auth-narrow-no-overflow', m.overflow.document === 0 && m.overflow.stream === 0
      && m.overflow.error === 0 && m.overflow.actions === 0, m.overflow);
    check('auth-narrow-compact', m.actions.buttonHeight <= 28, m.actions);
    check('auth-narrow-raw-kept', m.error.rawVisible && m.error.rawText.includes('API Key'), m.error);
    await clickAction();
    m = await measure();
    record('auth-narrow-failure', m);
    check('auth-narrow-failure-text', m.actions.statusText === '设置没有打开，请重试。'
      && m.actions.statusState === 'error' && m.actions.buttonDisabled === false, m.actions);
    check('auth-narrow-failure-raw-kept', m.error.rawText === longRaw, m.error);
    check('auth-narrow-failure-contrast', m.actions.statusContrast >= 4.5, m.actions);
    await shot('06-auth-failure-dark-700');

    /* 4. 700px 浅色：模型错误、English 长标题与动作 */
    await setTheme('light');
    await render('model', 'Current model is unavailable. Check the provider model list and select another model before retrying.', 'success');
    await shot('07-model-light-700');
    m = await measure();
    record('model-narrow-light', m);
    check('model-narrow-no-overflow', m.overflow.document === 0 && m.overflow.stream === 0
      && m.overflow.error === 0 && m.overflow.actions === 0, m.overflow);
    check('model-narrow-contrast', m.actions.buttonContrast >= 4.5, m.actions);
    await clickAction();
    await shot('08-model-success-light-700');

    /* 5. 深色宽屏：模型入口默认态补齐矩阵 */
    await setTheme('dark');
    await setViewport(1320, 820);
    await render('model', '当前模型不可用', 'success');
    await shot('09-model-dark-1320');

    const failed = assertions.filter((item) => !item.pass);
    fs.writeFileSync(path.join(OUT, 'measurements.json'), JSON.stringify({
      browser: CHROME, assertions, failures: failed, metrics,
    }, null, 2));
    console.log('\n断言: ' + (assertions.length - failed.length) + '/' + assertions.length + ' 通过');
    console.log('验收测量写入: ' + path.join(OUT, 'measurements.json'));
    if (failed.length) throw new Error('P4-B 视觉验收有 ' + failed.length + ' 条断言失败');
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
    try { harness.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
