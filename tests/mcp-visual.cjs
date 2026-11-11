/* MCP 管理 / 市场页面的真实 Chromium 截图取证。
 *
 * 页面仍由 tests/visual-harness.cjs 提供脚本数据，不写用户的 mcp.json，
 * 也不访问 Registry。这里只补 MCP 管理页需要的三个夹具端点，然后走真实
 * 前端渲染路径截图 —— jsdom 不做布局，不能替代这一步。
 *
 * 用法：node tests/mcp-visual.cjs
 * 产物：.shots/mcp/{01-management,02-add-modal,03-market}.png
 * 只用于验收取证，不属于 npm test 的 canonical 链。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.shots', 'mcp');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9225);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-mcp-shot-'));

  const harness = spawn(process.execPath, [path.join(ROOT, 'tests', 'visual-harness.cjs')], {
    cwd: world,
    env: { ...process.env, HARNESS_PORT: '0', VISUAL_UPLOAD_DIR: path.join(world, 'uploads') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const harnessErrors = [];
  harness.stderr.on('data', (c) => harnessErrors.push(String(c)));
  const origin = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('视觉夹具启动超时：' + harnessErrors.join(''))), 15000);
    harness.stdout.on('data', (c) => {
      buf += c;
      const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    harness.on('exit', (code) => { clearTimeout(timer); reject(new Error(`视觉夹具提前退出（${code}）：${harnessErrors.join('')}`)); });
  });

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-component-update', '--disable-background-networking',
    '--disable-default-apps', '--metrics-recording-only', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(world, 'chrome')}`,
    '--window-size=1440,960', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let targets = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = await r.json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch { /* 还没起来 */ }
  }
  const page = targets && targets.find((t) => t.type === 'page');
  if (!page) throw new Error('拿不到 DevTools page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || '未知异常');
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  const waitFor = async (expression, label, timeout = 15000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await evalJs(expression)) return;
      await sleep(100);
    }
    throw new Error(`等待超时：${label}`);
  };
  const shot = async (name) => {
    await sleep(250);
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    console.log('截图: ' + path.relative(ROOT, file));
  };
  const click = (selector) => evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('找不到 ${selector.replace(/'/g, "\\'")}');
    el.click();
    return true;
  })()`);
  const setValue = (selector, value) => evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('找不到字段 ${selector.replace(/'/g, "\\'")}');
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

  const closeChrome = () => { try { chrome.kill(); } catch { /* ignore */ } };
  const closeHarness = () => { try { harness.kill(); } catch { /* ignore */ } };
  const cleanup = () => { closeChrome(); closeHarness(); };
  process.on('exit', cleanup);

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: origin + '/' });
    await waitFor(`document.readyState === 'complete' && !!document.getElementById('navMcp')`, '应用外壳');

    await evalJs(`document.getElementById('navMcp').click()`);
    await waitFor(`!!document.querySelector('.mcp-page-inner') && !document.querySelector('.mcp-loading')`, 'MCP 管理页');
    await waitFor(`document.querySelectorAll('.mcp-server').length >= 4`, '服务器列表');
    const title = await evalJs(`document.querySelector('.mcp-page-title, .settings-page-title')?.textContent || ''`);
    if (!title.includes('MCP')) throw new Error('MCP 管理页标题不对：' + title);
    if (await evalJs(`document.getElementById('navMcp').classList.contains('is-active')` ) !== true) {
      throw new Error('左侧导航没有投影到 navMcp');
    }
    await shot('01-management');

    await click('.mcp-page-actions button.primary');
    await waitFor(`!document.getElementById('modal').hidden && !!document.querySelector('[data-field="name"]')`, '新增表单');
    await setValue('[data-field="name"]', 'playwright');
    await setValue('[data-field="description"]', '用无障碍树驱动浏览器：导航、点击、填表、截图。');
    await click('[data-field="add-arg"]');
    await waitFor(`!!document.querySelector('[data-field="args-0"]')`, '第一个参数');
    await setValue('[data-field="args-0"]', '-y');
    await click('[data-field="add-arg"]');
    await waitFor(`!!document.querySelector('[data-field="args-1"]')`, '第二个参数');
    await setValue('[data-field="args-1"]', '@playwright/mcp@latest');
    await click('[data-field="add-env"]');
    await waitFor(`!!document.querySelector('[data-field="env-key-0"]')`, '环境变量行');
    await setValue('[data-field="env-key-0"]', 'BROWSER_HEADLESS');
    await setValue('[data-field="env-value-0"]', 'true');
    await setValue('[data-field="timeout"]', '30');
    await evalJs(`(() => { const b = document.querySelector('#modalCard .mcp-modal-body'); if (b) b.scrollTop = 0; return true; })()`);
    /* 表单比列表页长；用更高的视口截完整弹层，避免只看到上半个表单。 */
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1180, deviceScaleFactor: 1, mobile: false });
    await shot('02-add-modal');
    /* 表单内容超过弹层最大高度，第二张记录滚动后的环境变量 / 高级区。 */
    await evalJs(`(() => { const b = document.querySelector('#modalCard .mcp-modal-body'); if (b) b.scrollTop = b.scrollHeight; return true; })()`);
    await shot('02-add-modal-lower');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

    await evalJs(`document.querySelector('#modalCard .mcp-modal-head .mcp-icon-btn')?.click()`);
    await waitFor(`document.getElementById('modal').hidden`, '关闭表单');
    await click('.mcp-page-actions button[data-focus-key="market"]');
    await waitFor(`!!document.querySelector('.mcp-market-page .mcp-market-card:not(.is-skeleton)')`, 'MCP 市场');
    await waitFor(`document.querySelectorAll('.mcp-market-card:not(.is-skeleton)').length >= 9`, '市场卡片');
    await shot('03-market');

    /* 安装确认：必须看得见实际会写入的命令、scope 与“敏感值不会显示”边界。 */
    await evalJs(`(() => {
      const btn = [...document.querySelectorAll('.mcp-market-card .mcp-market-install')].find((b) => !b.disabled);
      if (!btn) throw new Error('没有可安装的卡片');
      btn.click();
      return true;
    })()`);
    await waitFor(`!!document.querySelector('.mcp-install-modal [data-market-preview]')`, '安装确认弹层');
    await evalJs(`(() => { const b = document.querySelector('#modalCard .mcp-modal-body'); if (b) b.scrollTop = 0; return true; })()`);
    await shot('04-install-preview');

    if (pageErrors.length) throw new Error('页面运行期异常：' + pageErrors.join(' | '));
    console.log('PASS MCP 视觉取证完成');
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error('FAIL ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
