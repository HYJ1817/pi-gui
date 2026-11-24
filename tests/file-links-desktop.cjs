/* 工作区文件引用 / 工作区外授权 / 外部编辑器的真实桌面验收。
 *
 * 运行打包后的 Pi GUI.exe（真实 Electron 主进程、preload、内嵌后端），
 * 使用 os.tmpdir() 里的两个工作区与一个外部目录；不调用模型、不写用户项目。
 *
 * 覆盖：
 *   - 会话内文件引用、纯文本相对路径、同名文件选择器、行号定位、图片；
 *   - 工作区外文件的原生确认窗口（用 SendKeys 选择按钮）、授权后预览、
 *     目录授权、撤销后拒绝、重启后长期授权恢复；
 *   - 设置里的编辑器检测、选择、持久化，以及 Ctrl+Click 用 VS Code 打开并带行号；
 *   - 两个工作区（A/B）同名文件隔离。
 *
 * 用法：npm run build:app -- --rebuild && node tests/file-links-desktop.cjs
 * 产物：.shots/file-links-desktop/
 */
'use strict';
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createFileLinksWorld, makePng } = require('./file-links-fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.env.FILE_LINKS_EXE || path.join(ROOT, 'dist-app', 'Pi GUI-win32-x64', 'Pi GUI.exe');
const OUT = path.join(ROOT, '.shots', 'file-links-desktop');
const HELPER = path.join(__dirname, 'helpers', 'native-dialog.ps1');
const DIALOG_TITLE = '访问工作区外文件';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(get, label, attempts = 160, interval = 150) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await Promise.resolve().then(get).catch(() => null);
    if (value) return value;
    await sleep(interval);
  }
  throw new Error('timeout: ' + label);
}

let checks = 0;
const failures = [];
const results = { startedAt: new Date().toISOString(), checks: [], shots: [], runs: [] };
function check(name, value, detail = null) {
  checks += 1;
  if (value) {
    results.checks.push({ name, ok: true, detail });
    console.log('  ok  ' + name + (detail ? '  ' + JSON.stringify(detail) : ''));
  } else {
    failures.push(name);
    results.checks.push({ name, ok: false, detail });
    console.error('  FAIL ' + name + '  ' + JSON.stringify(detail));
  }
}
function requireCheck(name, value, detail = null) {
  check(name, value, detail);
  if (!value) throw new Error('failed: ' + name);
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function prepareWorld() {
  const base = createFileLinksWorld();
  const { rootA, rootB, world } = base;
  write(rootA, 'src/index.js', "export const where = 'src 版本';\n");
  write(rootA, 'public/index.js', "export const where = 'public 版本';\n");
  write(rootA, 'tests/index.js', "export const where = 'tests 版本';\n");
  write(rootA, 'src/main.ts', Array.from({ length: 30 }, (_, index) =>
    index === 11 ? 'export const entry = "main 第 12 行";' : '// line ' + (index + 1)).join('\n') + '\n');
  const ext = path.join(world, '外部 资料');
  write(ext, '验收 报告.md', '# 外部报告\n\n这是工作区之外的第三行。\n\n结束。\n');
  write(ext, '外部 图.png', makePng(96, 64));
  write(ext, '拒绝 脚本.cmd', '@echo off\r\necho should never run\r\n');
  return { ...base, ext };
}

function launch({ cwd, dataDir, label, port, cdp }) {
  const env = {
    ...process.env,
    PI_CWD: cwd,
    PI_GUI_DATA: path.join(dataDir, 'data'),
    PI_GUI_RUNTIME_DIR: path.join(dataDir, 'runtime'),
    PI_GUI_OPEN: '0',
    PORT: String(port),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [
    `--remote-debugging-port=${cdp}`,
    // Electron 的 userData（编辑器设置、Chromium profile）也必须隔离，
    // 否则验收会写用户真实的 %APPDATA%\Pi GUI。
    `--user-data-dir=${path.join(dataDir, 'profile')}`,
    '--no-sandbox',
    '--in-process-gpu',
  ], {
    cwd: path.dirname(EXE),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  const run = { label, pid: child.pid, port, cdp, startedAt: new Date().toISOString() };
  results.runs.push(run);
  return { child, log: () => log, run, port, cdp };
}

async function waitHealth(app) {
  await until(async () => (await fetch(`http://127.0.0.1:${app.port}/api/health`)).ok, 'backend health', 240, 250);
}

async function connect(app) {
  const target = await until(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${app.cdp}/json/list`)).json();
    return pages.find((page) => page.type === 'page' && page.url.includes(String(app.port)))?.webSocketDebuggerUrl;
  }, 'DevTools page', 200, 200);
  const ws = new WebSocket(target);
  await once(ws, 'open');
  let id = 0;
  const pending = new Map();
  const requests = [];
  const exceptions = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
      return;
    }
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params?.request?.url || '');
    if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || 'exception');
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, (message) => message.error ? reject(Error(message.error.message)) : resolve(message.result));
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  return { ws, send, evaluate, requests, exceptions };
}

async function waitApp(page, app, cwd) {
  await until(() => page.evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('#runtimeView'))`), 'app booted', 300, 200);
  await until(async () => {
    const state = await page.evaluate("import('/state.js').then((m) => ({ cwd: m.S.cwd, bridge: m.S.bridgeState }))");
    return state?.cwd && path.resolve(state.cwd) === path.resolve(cwd);
  }, 'classic cwd ' + cwd, 240, 200);
  try {
    const { windowId } = await page.send('Browser.getWindowForTarget');
    await page.send('Browser.setWindowBounds', { windowId, bounds: { width: 1320, height: 900 } });
    await sleep(400);
  } catch { /* older Electron: keep default size */ }
}

async function shot(page, name) {
  const image = await page.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
  results.shots.push(path.relative(ROOT, file));
  console.log('  shot ' + path.relative(ROOT, file));
}

async function point(page, selector) {
  await page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('missing ' + ${JSON.stringify(selector)});
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
  })()`);
  await sleep(180);
  return page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('missing ' + ${JSON.stringify(selector)});
    const rect = element.getBoundingClientRect();
    return { x: rect.x + Math.min(rect.width / 2, 120), y: rect.y + rect.height / 2 };
  })()`);
}

async function move(page, selector) {
  const at = await point(page, selector);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
}

async function click(page, selector) {
  const at = await point(page, selector);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await sleep(220);
}

async function ctrlClick(page, selector) {
  const at = await point(page, selector);
  // CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8。用真实鼠标事件，
  // 不走 JS dispatchEvent，避免“只有合成事件才生效”的假通过。
  const modifiers = 2;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, modifiers });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1, modifiers });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1, modifiers });
  await sleep(300);
}

function codeProcesses() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='Code.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"],
    { encoding: 'utf8', windowsHide: true });
  const text = String(result.stdout || '').trim();
  if (!text) return [];
  const value = JSON.parse(text);
  return Array.isArray(value) ? value : [value];
}

function killCodeFor(marker) {
  let killed = 0;
  for (const row of codeProcesses()) {
    if (!String(row.CommandLine || '').includes(marker)) continue;
    spawnSync('taskkill', ['/pid', String(row.ProcessId), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killed += 1;
  }
  return killed;
}

function helpDialog(app, { shiftTabs = 0, screenshot = '' } = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER,
    '-TitleLike', DIALOG_TITLE, '-AppTitle', 'pi-GUI', '-ShiftTabs', String(shiftTabs), '-ProcessId', String(app.child.pid),
    '-KeyDelayMs', '900', '-TimeoutSeconds', '20'];
  if (screenshot) args.push('-Screenshot', screenshot);
  const result = spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function killApp(app) {
  if (!app?.child || app.child.exitCode !== null) return;
  spawnSync('taskkill', ['/pid', String(app.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

function seedMessage(root, text) {
  return `(async () => {
    window.__surface = await import('/ui/workspace-surface.js');
    window.__S = (await import('/state.js')).S;
    window.__M = await import('/messages.js');
    Object.assign(__S, { hasProject: true, bridgeState: 'ready', streaming: false, stopping: false, cwd: ${JSON.stringify(root)} });
    __surface.showChat();
    __M.clearThread();
    __M.rebuildFromMessages({ messages: [
      { role: 'user', content: [{ type: 'text', text: '文件引用桌面验收' }] },
      { role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(text)} }] },
    ] }, 'desktop-accept');
    document.documentElement.dataset.theme = 'dark';
    return true;
  })()`;
}

(async () => {
  if (!fs.existsSync(EXE)) throw new Error('missing packaged app: ' + EXE + ' (run npm run build:app -- --rebuild)');
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const world = prepareWorld();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-file-links-desktop-data-'));
  console.log('world A ' + world.rootA);
  console.log('world B ' + world.rootB);
  console.log('external ' + world.ext);
  console.log('data ' + dataDir);

  const ports = [{ port: 17891, cdp: 19231 }, { port: 17892, cdp: 19232 }, { port: 17893, cdp: 19233 }];
  let app = null;
  let page = null;

  try {
    /* ---------------- A：引用、同名、外部授权、编辑器设置 ---------------- */
    app = launch({ cwd: world.rootA, dataDir, label: 'A', ...ports[0] });
    await waitHealth(app);
    page = await connect(app);
    await waitApp(page, app, world.rootA);
    await sleep(3500);

    const text = [
      '文件引用验收：',
      '',
      '- 源码 `src/app.ts:18`，范围 `src/app.ts:18-24`；样式 `src/styles.css`。',
      '- 纯文本入口 src/main.ts:12 应该被识别；裸文件名 `notes.txt` 也应该升级。',
      '- 同名文件 `index.js` 需要用户选择。',
      '- 外部报告 `' + path.join(world.ext, '验收 报告.md') + ':3`，外部图片 `' + path.join(world.ext, '外部 图.png') + '`。',
      '- 不能误识别：`npm install`、v1.2.3、https://example.com/a.ts。',
    ].join('\n');
    await page.evaluate(seedMessage(world.rootA, text));
    await until(() => page.evaluate("document.querySelectorAll('a.md-file-link').length >= 6"), 'chips rendered', 160, 200);
    await until(() => page.evaluate("Boolean(document.querySelector('a.md-file-link[data-file-path=\"src/main.ts\"]'))"), 'plain path upgraded', 120, 200);
    await sleep(400);

    const summary = await page.evaluate(`(() => ({
      links: [...document.querySelectorAll('a.md-file-link')].map((node) => ({
        path: node.dataset.filePath, external: node.dataset.fileExternal, line: node.dataset.fileLine,
        ambiguous: node.classList.contains('is-ambiguous'), text: node.textContent.trim(),
      })),
      candidates: document.querySelectorAll('.md-file-candidate,.md-file-plain-candidate').length,
      npm: [...document.querySelectorAll('a.md-file-link')].some((node) => node.textContent.includes('npm install')),
      version: [...document.querySelectorAll('a.md-file-link')].some((node) => node.textContent.includes('v1.2.3')),
      url: [...document.querySelectorAll('a.md-file-link')].some((node) => node.textContent.includes('example.com')),
    }))()`);
    check('the real packaged app renders internal, plain-text and external references',
      summary.links.some((link) => link.path === 'src/app.ts' && link.line === '18')
      && summary.links.some((link) => link.path === 'src/main.ts' && link.line === '12')
      && summary.links.some((link) => link.external === '1'),
      summary);
    check('npm packages, versions and URLs are not turned into file links',
      !summary.npm && !summary.version && !summary.url, { npm: summary.npm, version: summary.version, url: summary.url });
    await shot(page, '01-dark-conversation');

    await move(page, 'a.md-file-link[data-file-path="src/app.ts"]:not([data-file-end-line])');
    const tooltip = await until(() => page.evaluate(`(() => {
      const tip = document.querySelector('.ui-tooltip.file-link-tip');
      if (!tip || tip.hidden) return null;
      const rect = tip.getBoundingClientRect();
      return rect.width && rect.height ? { text: tip.textContent } : null;
    })()`), 'tooltip', 60, 100);
    check('hover shows the canonical path, real byte size and line', /app\.ts/.test(tooltip.text) && /L18/.test(tooltip.text)
      && /\d+(?:\.\d+)?\s?(?:B|KB|MB)/.test(tooltip.text), { tooltip: tooltip.text.slice(0, 160) });
    await shot(page, '02-hover');

    await click(page, 'a.md-file-link[data-file-path="src/app.ts"]:not([data-file-end-line])');
    await until(() => page.evaluate("document.querySelector('.files-preview-body')?.textContent.includes('A 工作区')"), 'internal open', 100, 150);
    const internal = await page.evaluate(`(() => ({
      line: document.querySelector('.files-line-highlight')?.dataset.lineFrom,
      active: document.querySelector('.files-tab-select[aria-selected="true"] .files-tab-label')?.textContent,
      text: document.querySelector('.files-preview-body')?.textContent.slice(0, 120),
    }))()`);
    check('clicking opens the right-side Files viewer at line 18', internal.line === '18' && internal.active === 'app.ts', internal);
    await shot(page, '03-internal-viewer');

    await click(page, 'a.md-file-link.is-ambiguous');
    const picker = await until(() => page.evaluate(`(() => {
      const menu = document.querySelector('.action-menu[role="menu"]');
      if (!menu) return null;
      return { labels: [...menu.querySelectorAll('.action-menu-label')].map((node) => node.textContent) };
    })()`), 'same-name picker', 80, 100);
    check('an ambiguous bare filename opens a picker with distinguishing paths',
      ['src/index.js', 'public/index.js', 'tests/index.js'].every((label) => picker.labels.includes(label)), picker);
    await shot(page, '04-same-name-picker');
    await page.evaluate(`[...document.querySelectorAll('.action-menu-item')]
      .find((node) => node.textContent.includes('tests/index.js')).click()`);
    await until(() => page.evaluate("document.querySelector('.files-preview-body')?.textContent.includes('tests 版本')"), 'picked file opened', 100, 150);
    const picked = await page.evaluate(`({
      active: document.querySelector('.files-tab-select[aria-selected="true"] .files-tab-label')?.textContent,
      text: document.querySelector('.files-preview-body')?.textContent.slice(0, 80),
    })`);
    check('the chosen same-name file opens in the existing viewer', picked.active === 'index.js' && picked.text.includes('tests 版本'), picked);
    await shot(page, '05-picked-file');

    /* 外部文件：悬停不应读元数据；点开先出现原生确认。 */
    const externalSelector = 'a.md-file-link[data-file-external="1"]';
    const beforeExternal = page.requests.filter((url) => url.includes('/api/files/external/')).length;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
    await sleep(300);
    await move(page, externalSelector);
    const externalTip = await until(() => page.evaluate(`(() => {
      const tip = document.querySelector('.ui-tooltip.file-link-tip');
      if (!tip || tip.hidden) return null;
      return /工作区外/.test(tip.textContent) ? tip.textContent : null;
    })()`), 'external tooltip', 60, 100);
    await sleep(500);
    const afterExternal = page.requests.filter((url) => url.includes('/api/files/external/')).length;
    check('an unauthorized external path only shows scope in the tooltip and reads nothing',
      /工作区外/.test(externalTip) && afterExternal === beforeExternal, { externalTip, beforeExternal, afterExternal });
    await shot(page, '06-external-hover');

    await page.send('Page.bringToFront');
    await sleep(400);
    await click(page, externalSelector);
    const fileDialog = helpDialog(app, { shiftTabs: 3, screenshot: path.join(OUT, '07-external-dialog.png') });
    check('the external authorization uses a native Electron confirmation', fileDialog.status === 0, {
      status: fileDialog.status, stderr: String(fileDialog.stderr || '').slice(0, 200),
    });
    await until(() => page.evaluate("document.querySelector('.files-preview-body')?.textContent.includes('工作区之外的第三行')"), 'external viewer', 120, 150);
    const externalOpen = await page.evaluate(`(() => ({
      active: document.querySelector('.files-tab-select[aria-selected="true"] .files-tab-label')?.textContent,
      path: document.querySelector('.files-preview-path')?.textContent,
      text: document.querySelector('.files-preview-body')?.textContent.slice(0, 100),
    }))()`);
    check('after confirmation the external file opens in the existing right-side viewer',
      externalOpen.text.includes('工作区之外的第三行') && /验收 报告\.md$/.test(externalOpen.active || ''), externalOpen);
    await shot(page, '08-external-authorized');

    /* 目录授权：记住此文件夹（长期）。 */
    await page.send('Page.bringToFront');
    await sleep(300);
    await page.evaluate(`(() => {
      const link = document.querySelector('a.md-file-link[data-file-external="1"][data-file-path$="外部 图.png"]');
      if (!link) throw new Error('external image chip missing');
      link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
    })()`);
    const externalMenu = await until(() => page.evaluate(`(() => {
      const menu = document.querySelector('.action-menu[role="menu"]');
      return menu ? [...menu.querySelectorAll('.action-menu-label')].map((node) => node.textContent) : null;
    })()`), 'external context menu', 60, 100);
    check('the external context menu exposes folder authorization', externalMenu.some((label) => label.includes('授权所在文件夹')), externalMenu);
    await page.evaluate(`[...document.querySelectorAll('.action-menu-item')]
      .find((node) => node.textContent.includes('授权所在文件夹')).click()`);
    const folderDialog = helpDialog(app, { shiftTabs: 1, screenshot: path.join(OUT, '09-folder-dialog.png') });
    check('a directory can be granted with a persistent choice', folderDialog.status === 0, {
      status: folderDialog.status, stderr: String(folderDialog.stderr || '').slice(0, 200),
    });
    await sleep(800);
    const grants = await page.evaluate("window.piGuiDesktop.externalFiles.list({ conversationId: null })");
    check('the grant ledger keeps a session file grant and a persistent directory grant',
      grants?.ok && grants.grants.some((grant) => grant.kind === 'file' && grant.scope === 'session')
      && grants.grants.some((grant) => grant.kind === 'directory' && grant.scope === 'persistent'), grants?.grants);

    await click(page, 'a.md-file-link[data-file-external="1"][data-file-path$="外部 图.png"]');
    await until(() => page.evaluate("document.querySelector('.files-preview-image img')?.naturalWidth > 0"), 'external image', 100, 150);
    const externalImage = await page.evaluate(`(() => {
      const img = document.querySelector('.files-preview-image img');
      return { width: img.naturalWidth, height: img.naturalHeight,
        active: document.querySelector('.files-tab-select[aria-selected="true"] .files-tab-label')?.textContent };
    })()`);
    check('the authorized directory lets an external image open through the controlled asset endpoint',
      externalImage.width === 96 && externalImage.height === 64, externalImage);
    await shot(page, '10-external-image');

    /* 设置：编辑器与访问 */
    await page.evaluate("document.querySelector('#navGlobalMore').click()");
    await until(() => page.evaluate("!!document.querySelector('#navAppearance') && !document.querySelector('#globalMoreMenu')?.hidden"), 'settings menu', 60, 100);
    await page.evaluate("document.querySelector('#navAppearance').click()");
    await until(() => page.evaluate("!!document.querySelector('.editor-settings-trigger')"), 'editor settings card', 100, 150);
    const editorState = await until(() => page.evaluate(`(async () => {
      const trigger = document.querySelector('.editor-settings-trigger');
      if (!trigger || trigger.disabled) return null;
      const state = await window.piGuiDesktop.editors.list();
      const vscode = state?.editors?.find((editor) => editor.id === 'vscode');
      return { label: trigger.textContent.trim(), title: trigger.title, vscode };
    })()`), 'editor detection', 60, 150);
    check('Settings → General auto-detects the installed Visual Studio Code via App Paths',
      editorState.vscode?.available === true && /Code\.exe$/i.test(editorState.vscode.path || ''), editorState);
    await page.evaluate("document.querySelector('.external-access-trigger').click()");
    await until(() => page.evaluate("document.querySelectorAll('.external-grant-item').length >= 2"), 'grant list', 60, 150);
    const listed = await page.evaluate(`[...document.querySelectorAll('.external-grant-item')].map((item) => ({
      path: item.querySelector('.external-grant-path')?.textContent,
      meta: item.querySelector('.external-grant-meta')?.textContent,
    }))`);
    check('the settings page lists the actual canonical paths and scope', listed.some((item) => item.meta === '文件夹 · 长期'), listed);
    await shot(page, '11-editor-and-access-settings');
    await page.evaluate("document.querySelector('.editor-settings-trigger').click()");
    await until(() => page.evaluate("!!document.querySelector('.action-menu')"), 'editor menu', 60, 100);
    const editorItems = await page.evaluate("[...document.querySelectorAll('.action-menu-label')].map((node) => node.textContent)");
    check('the editor menu offers the detected editors and re-detection', editorItems.some((label) => label.includes('Visual Studio Code')) && editorItems.includes('重新检测'), editorItems);
    await page.evaluate(`[...document.querySelectorAll('.action-menu-item')]
      .find((node) => node.textContent.includes('Visual Studio Code')).click()`);
    await until(() => page.evaluate("document.querySelector('.editor-settings-trigger')?.textContent.trim() === 'Visual Studio Code'"), 'editor saved', 60, 100);
    check('selecting the editor saves it', true);

    await page.evaluate("document.documentElement.dataset.theme = 'light'");
    await sleep(300);
    await shot(page, '12-light-settings');
    await page.evaluate("document.documentElement.dataset.theme = 'dark'");

    /* 撤销：外部标签页关闭，旧 grant 被拒绝。 */
    const fileGrant = grants.grants.find((grant) => grant.kind === 'file');
    await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('.external-grant-item')]
        .find((item) => item.querySelector('.external-grant-path')?.textContent.endsWith('验收 报告.md'));
      if (!row) throw new Error('file grant row missing');
      row.querySelector('.btn').click();
    })()`);
    await sleep(600);
    const afterRevoke = await page.evaluate(`(() => ({
      tabs: [...document.querySelectorAll('.files-tab-label')].map((node) => node.textContent),
    }))()`);
    const denied = await page.evaluate(`fetch('/api/files/external/document?' + new URLSearchParams({
      path: ${JSON.stringify(path.join(world.ext, '验收 报告.md'))}, grant: ${JSON.stringify(fileGrant.id)},
    })).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }))`);
    check('revoking closes the external tab and the backend rejects the old grant',
      !afterRevoke.tabs.some((label) => /验收 报告\.md/.test(label)) && denied.status === 403, { afterRevoke, denied });

    /* ---------------- B：同名文件隔离 + 编辑器偏好恢复 ---------------- */
    killApp(app);
    await sleep(2500);
    app = launch({ cwd: world.rootB, dataDir, label: 'B', ...ports[1] });
    await waitHealth(app);
    page = await connect(app);
    await waitApp(page, app, world.rootB);
    await sleep(3500);
    await page.evaluate(seedMessage(world.rootB, 'B 工作区的同名文件 `src/app.ts`，内容必须来自 B。'));
    await until(() => page.evaluate("Boolean(document.querySelector('a.md-file-link[data-file-path=\"src/app.ts\"]'))"), 'B chip', 100, 200);
    await click(page, 'a.md-file-link[data-file-path="src/app.ts"]:not([data-file-end-line])');
    await until(() => page.evaluate("document.querySelector('.files-preview-body')?.textContent.includes('project-b')"), 'B file open', 100, 150);
    const bState = await page.evaluate(`({
      text: document.querySelector('.files-preview-body')?.textContent.slice(0, 80),
      cwd: document.querySelector('a.md-file-link')?.dataset.fileCwd,
    })`);
    check('a second workspace opens its own same-named file, not workspace A', bState.text.includes('project-b') && /project-b/.test(bState.cwd || ''), bState);
    await shot(page, '13-workspace-b');
    await page.evaluate("document.querySelector('#navGlobalMore').click()");
    await until(() => page.evaluate("!!document.querySelector('#navAppearance') && !document.querySelector('#globalMoreMenu')?.hidden"), 'B settings', 60, 100);
    await page.evaluate("document.querySelector('#navAppearance').click()");
    await until(() => page.evaluate("document.querySelector('.editor-settings-trigger')?.textContent.trim() === 'Visual Studio Code'"), 'restored editor', 100, 150);
    const bGrants = await page.evaluate("window.piGuiDesktop.externalFiles.list({ conversationId: null })");
    check('the editor preference survives restart and workspace B does not inherit A grants',
      !bGrants?.grants?.some((grant) => /验收 报告|外部 图/.test(grant.target)), bGrants?.grants);
    await shot(page, '14-workspace-b-settings');

    /* ---------------- A 再次启动：长期目录授权恢复 + VS Code 行号 ---------------- */
    killApp(app);
    await sleep(2500);
    app = launch({ cwd: world.rootA, dataDir, label: 'A-restored', ...ports[2] });
    await waitHealth(app);
    page = await connect(app);
    await waitApp(page, app, world.rootA);
    await sleep(3500);
    const restoredGrants = await page.evaluate("window.piGuiDesktop.externalFiles.list({ conversationId: null })");
    check('a persistent directory grant is restored after restart',
      restoredGrants?.grants?.some((grant) => grant.kind === 'directory' && grant.scope === 'persistent'), restoredGrants?.grants);

    await page.evaluate(seedMessage(world.rootA, '再次打开外部图片 `' + path.join(world.ext, '外部 图.png') + '` 和源码 `src/app.ts:18`。'));
    await until(() => page.evaluate("Boolean(document.querySelector('a.md-file-link[data-file-external=\"1\"]'))"), 'restored external chip', 100, 200);
    await click(page, 'a.md-file-link[data-file-external="1"]');
    await until(() => page.evaluate("document.querySelector('.files-preview-image img')?.naturalWidth > 0"), 'restored external image', 100, 150);
    check('the restored directory grant reopens the external image without a new dialog', true);
    await shot(page, '15-restored-grant');

    /* 选择 VS Code（偏好已恢复）后 Ctrl+Click：真实启动并带 --goto 行号。 */
    await page.evaluate("document.querySelector('#navGlobalMore').click()");
    await until(() => page.evaluate("!!document.querySelector('#navAppearance') && !document.querySelector('#globalMoreMenu')?.hidden"), 'A settings', 60, 100);
    await page.evaluate("document.querySelector('#navAppearance').click()");
    await until(() => page.evaluate("document.querySelector('.editor-settings-trigger')?.textContent.trim() === 'Visual Studio Code'"), 'editor restored', 100, 150);
    await page.evaluate("document.querySelector('#navHome').click()");
    await sleep(800);
    await page.evaluate(seedMessage(world.rootA, '再次打开源码 `src/app.ts:18`。'));
    await until(() => page.evaluate("Boolean(document.querySelector('a.md-file-link[data-file-path=\"src/app.ts\"]'))"), 'code chip for editor', 100, 200);
    const codeMarker = path.join(world.rootA, 'src', 'app.ts');
    const beforeCode = codeProcesses();
    try {
      requireCheck('no VS Code instance is running before the real launch check',
        beforeCode.length === 0, beforeCode.map((row) => row.ProcessId));
      await ctrlClick(page, 'a.md-file-link[data-file-path="src/app.ts"]:not([data-file-end-line])');
      const code = await until(() => codeProcesses().find((row) => {
        const command = String(row.CommandLine || '');
        return command.includes('--goto') && command.includes(codeMarker + ':18');
      }), 'VS Code launched with --goto <abs>:18', 160, 250);
      check('Ctrl+Click launches the configured VS Code with the real absolute path and line 18',
        true, { beforeCode: beforeCode.length, pid: code.ProcessId, command: code.CommandLine });
      const codeTitle = await until(() => {
        const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
          `(Get-Process -Id ${Number(code.ProcessId)} -ErrorAction SilentlyContinue).MainWindowTitle`],
          { encoding: 'utf8', windowsHide: true });
        const title = String(result.stdout || '').trim();
        return /app\.ts/.test(title) ? title : null;
      }, 'VS Code window title', 160, 300);
      check('VS Code reports the opened file in its window title', /app\.ts/.test(codeTitle), codeTitle);
      await shot(page, '16-after-external-editor');
      const nativeShot = path.join(OUT, '17-vscode-editor.png');
      const capture = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', HELPER, '-TitleLike', 'app.ts', '-AppTitle', 'app.ts', '-ProcessId', String(code.ProcessId),
        '-NoKeys', '-ForegroundOnly', '-Screenshot', nativeShot, '-TimeoutSeconds', '20'],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      const shotOk = capture.status === 0 && fs.existsSync(nativeShot) && fs.statSync(nativeShot).size > 20000;
      if (shotOk) results.shots.push(path.relative(ROOT, nativeShot));
      check('a real screen capture shows VS Code with the opened file', shotOk,
        { helper: String(capture.stdout || '').trim(), stderr: String(capture.stderr || '').trim() });
    } finally {
      const killed = killCodeFor(codeMarker);
      if (killed) console.log('  cleaned VS Code processes: ' + killed);
    }

    /* 撤销长期目录授权后，外部图片不能继续读取。 */
    await page.send('Page.reload');
    await waitApp(page, app, world.rootA);
    await page.evaluate(seedMessage(world.rootA, '刷新后再次打开外部图片 `' + path.join(world.ext, '外部 图.png') + '`。'));
    await until(() => page.evaluate("Boolean(document.querySelector('a.md-file-link[data-file-external=\"1\"]'))"), 'post-reload chip', 100, 200);
    await page.evaluate("document.querySelector('#navGlobalMore').click()");
    await until(() => page.evaluate("!!document.querySelector('#navAppearance') && !document.querySelector('#globalMoreMenu')?.hidden"), 'revoke settings', 60, 100);
    await page.evaluate("document.querySelector('#navAppearance').click()");
    await until(() => page.evaluate("!!document.querySelector('.external-access-trigger')"), 'access card', 100, 150);
    await page.evaluate("document.querySelector('.external-access-trigger').click()");
    await until(() => page.evaluate("document.querySelectorAll('.external-grant-item').length >= 1"), 'directory grant row', 60, 150);
    await page.evaluate("document.querySelector('.external-grant-item .btn').click()");
    await sleep(600);
    const directoryGrant = restoredGrants.grants.find((grant) => grant.kind === 'directory');
    const afterFolderRevoke = await page.evaluate(`fetch('/api/files/external/asset?' + new URLSearchParams({
      path: ${JSON.stringify(path.join(world.ext, '外部 图.png'))}, grant: ${JSON.stringify(directoryGrant.id)},
    })).then((response) => response.status)`);
    check('after revoking the directory grant the external asset endpoint rejects the old grant', afterFolderRevoke === 403 || afterFolderRevoke === 404, afterFolderRevoke);

    results.finishedAt = new Date().toISOString();
    results.checksTotal = checks;
    results.failures = failures;
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    console.log(`\nfile-links-desktop: ${checks - failures.length}/${checks} checks passed; screenshots=${results.shots.length}`);
    if (failures.length) console.error('FAILED: ' + failures.join(' | '));
    process.exitCode = failures.length ? 1 : 0;
  } catch (error) {
    console.error(error);
    results.finishedAt = new Date().toISOString();
    results.checksTotal = checks;
    results.failures = failures;
    results.error = String(error?.stack || error);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    process.exitCode = 1;
  } finally {
    try { page?.ws?.close(); } catch { /* already closed */ }
    killApp(app);
    await sleep(500);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
