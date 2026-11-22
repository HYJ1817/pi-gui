/* 技能 / 扩展 / MCP 三个能力页与「常规 / 快捷键 / 信息」参照页的真实 Chromium 截图取证。
 *
 * 画面来自 tests/visual-harness.cjs 的脚本数据（不启动真 pi、不读用户目录、不联网）。
 * 参照页只用于并排核对视觉语言，不改它们的源码。
 *
 * 覆盖：1320×820 与 700×600，深 / 浅主题，每个页面各一张；
 * 另在 1320×820 深色下补 Hover / 键盘焦点 / Disabled / Loading / Error / Selected。
 *
 * 用法：node tests/capability-pages-visual.cjs --tag=before
 * 产物：.shots/capability-pages/<tag>/*.png 与 manifest.json
 * 只用于验收取证，不属于 npm test 的 canonical 链。 */
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ONLY = (() => {
  const arg = process.argv.find((value) => value.startsWith('--only='));
  return arg ? arg.slice(7) : '';
})();
const TAG = (() => {
  const arg = process.argv.find((value) => value.startsWith('--tag='));
  return arg ? arg.slice(6).replace(/[^\w.-]/g, '') || 'run' : 'run';
})();
const OUT = path.join(ROOT, '.shots', 'capability-pages', TAG);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FIXED_PORT = process.env.CDP_PORT ? Number(process.env.CDP_PORT) : 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-capability-shot-'));

  const harness = spawn(process.execPath, [path.join(ROOT, 'tests', 'visual-harness.cjs')], {
    cwd: world,
    env: { ...process.env, HARNESS_PORT: '0', VISUAL_UPLOAD_DIR: path.join(world, 'uploads') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const harnessErrors = [];
  harness.stderr.on('data', (chunk) => harnessErrors.push(String(chunk)));
  const origin = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('视觉夹具启动超时：' + harnessErrors.join(''))), 15000);
    harness.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    harness.on('exit', (code) => { clearTimeout(timer); reject(new Error(`视觉夹具提前退出（${code}）：${harnessErrors.join('')}`)); });
  });

  if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME);
  const port = FIXED_PORT || await freePort();
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-component-update', '--disable-background-networking',
    '--disable-default-apps', '--metrics-recording-only', '--hide-scrollbars',
    `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(world, 'chrome')}`,
    '--window-size=1320,820', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let targets = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await sleep(250);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await response.json();
      if (targets.some((target) => target.type === 'page')) break;
    } catch { /* 还没起来 */ }
  }
  const page = targets && targets.find((target) => target.type === 'page');
  if (!page) throw new Error('拿不到 DevTools page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || '未知异常');
    }
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evalJs = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 400));
    return result.result?.result?.value;
  };
  const waitFor = async (expression, label, timeout = 15000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await evalJs(expression)) return;
      await sleep(100);
    }
    throw new Error(`等待超时：${label}`);
  };
  const setViewport = (width, height) => send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  const shots = [];
  const computed = [];
  const shot = async (name) => {
    await sleep(250);
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(result.result.data, 'base64'));
    const bytes = fs.statSync(file).size;
    shots.push({ name, bytes });
    console.log(`截图: ${path.relative(ROOT, file)}（${bytes} 字节）`);
  };
  const click = (selector) => evalJs(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('找不到 ${selector.replace(/'/g, "\\'")}');
    node.click();
    return true;
  })()`);
  const clickText = (selector, text) => evalJs(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const node = nodes.find((candidate) => (candidate.textContent || '').includes(${JSON.stringify(text)}));
    if (!node) throw new Error('找不到 ${selector.replace(/'/g, "\\'")} / ${text}');
    node.click();
    return true;
  })()`);
  const setValue = (selector, value) => evalJs(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('找不到字段 ${selector.replace(/'/g, "\\'")}');
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const mouseAt = async (type, selector) => {
    const box = await evalJs(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('找不到 ${selector.replace(/'/g, "\\'")}');
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await send('Input.dispatchMouseEvent', type === 'mouseMoved'
      ? { type, x: box.x, y: box.y }
      : { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  };
  const hover = async (selector) => {
    const box = await evalJs(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('找不到 ${selector.replace(/'/g, "\\'")}');
      const rect = node.getBoundingClientRect();
      return { x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + rect.height / 2 };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  };
  const metricsOf = (selector, props) => evalJs(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const style = getComputedStyle(node);
    return Object.fromEntries(${JSON.stringify(props)}.map((name) => [name, style.getPropertyValue(name)]));
  })()`);
  const record = async (label, selector, props) => {
    const value = await metricsOf(selector, props);
    computed.push({ label, selector, ...value });
    return value;
  };
  const closeModal = async (label = '取消') => {
    await clickText('#modalCard button', label);
    await waitFor(`document.getElementById('modal').hidden`, '弹窗关闭');
    await sleep(150);
  };
  const setSkillsMode = async (patch) => {
    const response = await fetch(origin + '/api/__skills/mode', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error('设置技能夹具形态失败：' + response.status);
    return response.json();
  };
  const resetSkillsMode = () => setSkillsMode({ trusted: false, empty: false, error: false, restartPending: false });

  const closeChrome = () => { try { chrome.kill(); } catch { /* ignore */ } };
  const closeHarness = () => { try { harness.kill(); } catch { /* ignore */ } };
  process.on('exit', () => { closeChrome(); closeHarness(); });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: origin + '/' });
  await waitFor(`document.readyState === 'complete' && !!document.getElementById('navExtensions')`, '首屏');

  async function applyTheme(theme) {
    await evalJs(`localStorage.setItem('pi-gui.theme.v1', ${JSON.stringify(theme)})`);
    await send('Page.reload', { ignoreCache: false });
    await waitFor(`document.readyState === 'complete' && !!document.getElementById('navExtensions')`, `主题 ${theme}`);
    await sleep(400);
    const applied = await evalJs('document.documentElement.dataset.theme');
    assert(applied === theme, `主题没有生效：${applied}`);
  }
  async function reload(theme) {
    await send('Page.reload', { ignoreCache: false });
    await waitFor(`document.readyState === 'complete' && !!document.getElementById('navExtensions')`, `重载 ${theme}`);
    await sleep(400);
    const applied = await evalJs('document.documentElement.dataset.theme');
    assert(applied === theme, `主题没有生效：${applied}`);
  }
  async function openSettings(theme) {
    await reload(theme);
    await evalJs(`document.getElementById('navGlobalMore').click()`);
    await waitFor(`!document.getElementById('globalMoreMenu').hidden`, '设置菜单');
    await sleep(150);
  }
  async function openReference(theme, id, ready) {
    await openSettings(theme);
    await click('#' + id);
    await waitFor(ready, id);
    await sleep(400);
  }
  async function openSkills(theme, { mode } = {}) {
    await resetSkillsMode();
    if (mode) await setSkillsMode(mode);
    await openReference(theme, 'navSkills', `!!document.querySelector('#workSurface .skills-page') && !document.querySelector('#workSurface .skills-content.is-loading')`);
  }
  /* 安装一个只改响应的 fetch 补丁：用于制造 Disabled / Loading 等真实渲染状态。 */
  const patchFetch = (match, bodyPatch) => evalJs(`(() => {
    window.__originalFetch = window.__originalFetch || window.fetch.bind(window);
    window.fetch = async (...args) => {
      const url = String(args[0] && args[0].url ? args[0].url : args[0]);
      const response = await window.__originalFetch(...args);
      if (!url.includes(${JSON.stringify(match)})) return response;
      const body = await response.clone().json();
      return new Response(JSON.stringify(Object.assign(body, ${JSON.stringify(bodyPatch)})), {
        status: response.status, headers: { 'content-type': 'application/json' },
      });
    };
  })()`);
  const holdFetch = (match) => evalJs(`(() => {
    window.__originalFetch = window.__originalFetch || window.fetch.bind(window);
    window.fetch = async (...args) => {
      const url = String(args[0] && args[0].url ? args[0].url : args[0]);
      if (url.includes(${JSON.stringify(match)})) return new Promise(() => {});
      return window.__originalFetch(...args);
    };
  })()`);
  async function openMcp(theme, { patch } = {}) {
    await reload(theme);
    if (patch) await patchFetch('/api/mcp/servers', patch);
    await evalJs(`document.getElementById('navGlobalMore').click()`);
    await waitFor(`!document.getElementById('globalMoreMenu').hidden`, '设置菜单');
    await click('#navMcp');
    await waitFor(`!!document.querySelector('#workSurface .mcp-page .mcp-group')`, 'MCP 页');
    await sleep(500);
  }
  async function openExtensions(theme, { tab = 'installed', patch = '' } = {}) {
    await reload(theme);
    if (patch) await evalJs(patch);
    await click('#navExtensions');
    await waitFor(`!!document.querySelector('#workSurface.extensions-page .extensions-head')`, '扩展页');
    if (tab === 'market') {
      await click('#extensionsTabMarket');
      await waitFor(`!!document.querySelector('#extensionsTabPanel .extensions-tab-market')`, '插件市场');
      await waitFor(`!!document.querySelector('.extensions-market-card')`, '插件卡片');
    }
    await waitFor(`!!document.querySelector('#extensionsTabPanel').childElementCount`, '扩展内容');
    await sleep(600);
  }
  async function openSkillsLoading(theme) {
    await reload(theme);
    await holdFetch('/api/skills');
    await evalJs(`document.getElementById('navGlobalMore').click()`);
    await waitFor(`!document.getElementById('globalMoreMenu').hidden`, '设置菜单');
    await click('#navSkills');
    await waitFor(`!!document.querySelector('#workSurface .skills-content .skills-empty')`, '技能加载态');
    await sleep(300);
  }
  /* 从页面卡片（tabIndex=-1）开始按真实 Tab，键盘焦点因此带 :focus-visible。 */
  async function tabWithin(selector, limit = 40) {
    await evalJs(`document.querySelector('#workSurface .settings-detail-card')?.focus()`);
    for (let i = 0; i < limit; i += 1) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      if (await evalJs(`document.activeElement && document.activeElement.matches(${JSON.stringify(selector)})`)) return true;
    }
    throw new Error('键盘 Tab 没有到达：' + selector);
  }
  async function openSkillsMarket(theme) {
    await openSkills(theme);
    await clickText('.skills-actions-bar button', '市场');
    await waitFor(`!!document.querySelector('#workSurface .skills-market')`, '技能市场');
    await sleep(500);
  }
  async function openMcpMarket(theme) {
    await openMcp(theme);
    await clickText('.mcp-page-actions button', '市场');
    await waitFor(`!!document.querySelector('#workSurface .mcp-market-page')`, 'MCP 市场');
    await sleep(500);
  }

  const pages = [
    { name: 'ref-general', open: (theme) => openReference(theme, 'navAppearance', `!!document.querySelector('#workSurface .settings-detail-card.appearance-card .settings-row')`) },
    { name: 'ref-shortcuts', open: (theme) => openReference(theme, 'navShortcutHelp', `!!document.querySelector('#workSurface .shortcut-settings-page .shortcut-row')`) },
    { name: 'ref-info', open: (theme) => openReference(theme, 'navInfo', `!!document.querySelector('#workSurface .settings-detail-card.about-settings-card .settings-row')`) },
    { name: 'skills-list', open: (theme) => openSkills(theme) },
    { name: 'skills-market', open: (theme) => openSkillsMarket(theme) },
    { name: 'extensions-installed', open: (theme) => openExtensions(theme, { tab: 'installed' }) },
    { name: 'extensions-market', open: (theme) => openExtensions(theme, { tab: 'market' }) },
    { name: 'mcp-list', open: (theme) => openMcp(theme) },
    { name: 'mcp-market', open: (theme) => openMcpMarket(theme) },
  ];

  if (ONLY !== 'states') {
  console.log('--- 1320×820 / 700×600，深色 / 浅色 ---');
  await applyTheme('dark');
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await applyTheme('light');
    for (const size of [{ w: 1320, h: 820, label: '1320x820' }, { w: 700, h: 600, label: '700x600' }]) {
      console.log(`--- ${size.label} ${theme} ---`);
      await setViewport(size.w, size.h);
      for (const entry of pages) {
        await entry.open(theme);
        await shot(`${entry.name}-${size.label}-${theme}`);
      }
    }
  }
  }

  if (ONLY !== 'pages') {
  console.log('--- 参照页面的表面度量（1320×820 深色） ---');
  await setViewport(1320, 820);
  await applyTheme('dark');
  await openReference('dark', 'navAppearance', `!!document.querySelector('#workSurface .settings-detail-card.appearance-card .settings-row')`);
  await record('ref-settings-row', '.settings-detail-card .settings-row', ['border-top-width', 'border-top-color', 'background-color', 'border-radius']);
  await record('ref-settings-card-title', '.settings-detail-card .ds-settings-card-title', ['font-size', 'font-weight', 'color']);
  await record('ref-page-title', '.settings-detail-card > h3', ['font-size', 'font-weight', 'color']);

  console.log('--- 状态：1320×820 深色 ---');
  await openSkills('dark');
  await record('skills-row-default', '.skill-row', ['border-top-width', 'border-top-color', 'background-color', 'border-radius']);
  await record('skills-group-icon-default', '.skills-group-glyph', ['border-top-width', 'border-top-color', 'background-color']);
  await record('skills-search-default', '.skills-search', ['border-top-width', 'border-top-color', 'background-color', 'height']);
  await record('skills-project-select-default', '.skills-project-select', ['border-top-width', 'border-top-color', 'background-color', 'height']);
  await record('skills-title', '.skills-title', ['font-size', 'font-weight']);
  await record('skills-group-title', '.skills-group-title', ['font-size', 'font-weight', 'color']);
  await hover('.skill-row');
  await shot('state-skills-row-hover-1320x820-dark');

  await reload('dark');
  await openSettings('dark');
  await click('#navSkills');
  await waitFor(`!!document.querySelector('#workSurface .skills-page .skills-group')`, '技能页');
  await tabWithin('.skills-search-input');
  await shot('state-skills-search-focus-1320x820-dark');
  await tabWithin('.skill-row-main');
  await shot('state-skills-row-focus-1320x820-dark');

  await openSkillsLoading('dark');
  await shot('state-skills-loading-1320x820-dark');
  await openSkills('dark', { mode: { empty: true } });
  await shot('state-skills-empty-1320x820-dark');
  await resetSkillsMode();
  await openSkills('dark', { mode: { error: true } });
  await shot('state-skills-error-1320x820-dark');
  await resetSkillsMode();

  await openSkills('dark');
  await evalJs(`(() => {
    const seg = [...document.querySelectorAll('.skills-scope .ds-segment-item')].find((node) => node.dataset.value === 'user');
    seg.click();
  })()`);
  await sleep(250);
  await shot('state-skills-selected-1320x820-dark');

  /* Pressed / pointer focus / success：设计系统状态矩阵里本页会实际出现的三种。 */
  await openSkills('dark');
  await mouseAt('mouseMoved', '.skills-actions-bar .btn.primary');
  await mouseAt('mousePressed', '.skills-actions-bar .btn.primary');
  await shot('state-skills-button-pressed-1320x820-dark');
  await mouseAt('mouseReleased', '.skills-actions-bar .btn.primary');
  await sleep(200);

  await openSkills('dark');
  await mouseAt('mousePressed', '.skills-search-input');
  await mouseAt('mouseReleased', '.skills-search-input');
  await sleep(200);
  await shot('state-skills-search-pointer-focus-1320x820-dark');

  await openSkills('dark');
  await clickText('.skills-actions-bar button', '新建');
  await waitFor(`!!document.querySelector('.skills-editor-dialog .skills-field-name input')`, '新建技能弹窗');
  await setValue('.skills-editor-dialog .skills-field-name input', 'meeting-notes');
  await setValue('.skills-editor-dialog textarea[aria-label="描述"]', '把会议记录整理成结论、待办与负责人。');
  await setValue('.skills-editor-dialog textarea[aria-label="正文"]', '# 会议笔记\n\n1. 先列结论，再列待办。\n');
  await sleep(900);
  await clickText('#modalCard .skills-dialog-foot button', '创建');
  await waitFor(`!!document.querySelector('.skills-notice.is-success')`, '成功提示');
  await sleep(300);
  await shot('state-skills-success-1320x820-dark');
  await click('.skills-notice-close');

  await openSkills('dark', { mode: { restartPending: true } });
  await shot('state-skills-restart-pending-1320x820-dark');
  await resetSkillsMode();
  await setViewport(700, 600);
  await openSkills('dark', { mode: { restartPending: true } });
  await shot('state-skills-restart-pending-700x600-dark');
  await resetSkillsMode();
  await setViewport(1320, 820);

  await openMcp('dark');
  await record('mcp-row-default', '.mcp-server', ['border-top-width', 'border-top-color', 'background-color', 'border-radius']);
  await record('mcp-group-icon-default', '.mcp-group-icon', ['border-top-width', 'border-top-color', 'background-color']);
  await record('mcp-search-default', '.mcp-search', ['border-top-width', 'border-top-color', 'background-color', 'height']);
  await record('mcp-project-select-default', '.mcp-project-select', ['border-top-width', 'border-top-color', 'background-color', 'height']);
  await record('mcp-group-title', '.mcp-group-title h4', ['font-size', 'font-weight', 'color']);
  await hover('.mcp-server');
  await shot('state-mcp-row-hover-1320x820-dark');
  await openMcp('dark', { patch: { trust: { trusted: false, requiresTrust: true } } });
  await shot('state-mcp-disabled-1320x820-dark');

  await openExtensions('dark', { tab: 'installed' });
  await record('extensions-row-default', '.extensions-card', ['border-top-width', 'border-top-color', 'background-color', 'border-radius']);
  await record('extensions-group-icon-default', '.extensions-group-icon', ['border-top-width', 'border-top-color', 'background-color']);
  await record('extensions-group-title', '.extensions-group-title', ['font-size', 'font-weight', 'color']);
  await hover('.extensions-card');
  await shot('state-extensions-row-hover-1320x820-dark');

  await openExtensions('dark', { tab: 'market' });
  await record('extensions-market-card', '.extensions-market-card', ['border-top-width', 'border-top-color', 'background-color', 'border-radius']);
  await record('extensions-market-refresh', '.extensions-refresh', ['background-color', 'color', 'border-top-width']);
  await evalJs(`(() => {
    const facet = document.querySelector('.extensions-categories [data-filter="devtools"]');
    if (facet) facet.click();
  })()`);
  await sleep(450);
  await shot('state-extensions-market-selected-1320x820-dark');

  console.log('--- 状态：1320×820 浅色 ---');
  await applyTheme('light');
  await openSkills('light');
  await hover('.skill-row');
  await shot('state-skills-row-hover-1320x820-light');
  await reload('light');
  await openSettings('light');
  await click('#navSkills');
  await waitFor(`!!document.querySelector('#workSurface .skills-page .skills-group')`, '技能页');
  await tabWithin('.skills-search-input');
  await shot('state-skills-search-focus-1320x820-light');
  await openMcp('light', { patch: { trust: { trusted: false, requiresTrust: true } } });
  await shot('state-mcp-disabled-1320x820-light');
  }

  await setViewport(1320, 820);
  const manifest = {
    tag: TAG,
    origin,
    generatedAt: new Date().toISOString(),
    viewport: { width: 1320, height: 820, deviceScaleFactor: 1 },
    shots,
    computed,
    pageErrors,
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`完成：${shots.length} 张截图，${computed.length} 条 computed style，页面异常 ${pageErrors.length} 条`);
  if (pageErrors.length) console.log(pageErrors.join('\n'));

  closeChrome();
  closeHarness();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
