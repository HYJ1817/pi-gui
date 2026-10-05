/* Offline P30 acceptance: actual renderer, preload and Browser controller.
 * All server data is the existing in-memory visual harness, userData is temporary.
 * Run: node tests/ui-ia-electron.cjs.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const tempWorld = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-p30-ui-'));
  env.P30_WORLD = tempWorld;
  const child = spawn(require('electron'), [__filename, '--no-sandbox', '--in-process-gpu'], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', e => { console.error(e); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; fs.rm(tempWorld, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }, error => { if (error) console.error('Fixture cleanup: ' + error.code); }); });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  app.on('window-all-closed', () => {}); // teardown owns the exit status
  const { createBrowserController } = require('../electron/browser-view.cjs');
  const { createBrowserAgentHost } = require('../electron/browser-agent-host.cjs');
  const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, '.shots/p30');
  const PORT = Number(process.env.P30_HARNESS_PORT || 0);
  let ORIGIN;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let win, harness, controller, agent, fixture, world, checks = 0, exitCode = 0;
  const errors = [], screenshots = [], facts = [];
  const check = (value, name) => { if (!value) throw new Error(name); checks++; console.log('PASS ' + name); };
  const read = expression => win.webContents.executeJavaScript(expression);
  const push = route => fetch(ORIGIN + route).then(r => r.json());
  const waitFor = async (expression, name) => {
    for (let n = 0; n < 100; n++) { if (await read(expression).catch(() => false)) return; await sleep(50); }
    throw new Error('Timeout: ' + name);
  };
  async function pointer(selector, hover = false) {
    const r = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`);
    if (!r) throw new Error('Invisible pointer target: ' + selector);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...r });
    if (!hover) {
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...r, button: 'left', clickCount: 1 });
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...r, button: 'left', clickCount: 1 });
    }
    await sleep(120);
  }
  async function key(key, code, vk, modifiers = 0) {
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(100);
  }
  async function shot(name, size) {
    await sleep(150);
    const f = await read(`(()=>{const r=e=>{const n=document.querySelector(e);if(!n)return null;const b=n.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}};return {ua:navigator.userAgent,size:[innerWidth,innerHeight],scroll:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],stage:r('#workspace'),head:r('.stage-head'),pane:r('#rightPane'),surface:document.querySelector('#rightPane').dataset.surface,mode:document.querySelector('#rightPane').dataset.mode,active:document.activeElement?.id,captionReserve:innerWidth-document.querySelector('.head-right').getBoundingClientRect().right}})()`);
    check(/Electron\//.test(f.ua), name + ' is Electron');
    check(f.scroll[0] <= f.size[0] + 1 && f.scroll[1] <= f.size[1] + 1, name + ' no page overflow');
    check(Math.abs(f.head.y) <= 1 && Math.abs(f.head.height - 46) <= 1, name + ' titlebar stable');
    if (!f.pane.width) check(f.captionReserve >= 138, name + ' native caption reserve');
    const file = `${name}-${size}.png`;
    fs.writeFileSync(path.join(OUT, file), (await win.webContents.capturePage()).toPNG());
    screenshots.push(file); facts.push({ name, ...f });
  }
  async function main() {
    world = process.env.P30_WORLD; app.setPath('userData', world);
    fs.mkdirSync(OUT, { recursive: true }); await app.whenReady();
    harness = spawn(process.execPath, [path.join(ROOT, 'tests/visual-harness.cjs')], { cwd: world, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: String(PORT) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    ORIGIN = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Harness did not start')), 10000);
      harness.stdout.on('data', chunk => { const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
      harness.once('error', reject); harness.once('exit', code => reject(new Error('Harness exited: ' + code)));
    });
    for (let n = 0; n < 80; n++) { try { if ((await fetch(ORIGIN + '/api/status')).ok) break; } catch {} await sleep(100); }
    fixture = require('node:http').createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>P30 local preview</title><style>body{margin:0;padding:24px;min-height:100vh;box-sizing:border-box;background:#f5f5f5;color:#222;font:16px system-ui}button{padding:6px 14px}</style><h1>Local preview</h1><button>Save</button>'); });
    await new Promise(r => fixture.listen(0, '127.0.0.1', r));
    win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, titleBarStyle: 'hidden', titleBarOverlay: { color: '#0d0d0d', symbolColor: '#9b9b9b', height: 46 }, autoHideMenuBar: true, webPreferences: { preload: path.join(ROOT, 'electron/preload.cjs'), contextIsolation: true, nodeIntegration: false } });
    controller = createBrowserController({ origin: ORIGIN, getWindow: () => win, ipcMain }); controller.register();
    agent = createBrowserAgentHost({ browser: controller, origin: ORIGIN, getWindow: () => win, ipcMain, extensionPath: path.join(ROOT, 'extensions/pi-gui-browser/index.js') }); await agent.start();
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3 && !message.includes('Electron Security Warning')) errors.push(message); });
    await win.loadURL(ORIGIN); win.show(); win.webContents.debugger.attach('1.3');
    await waitFor(`document.querySelector('#connText').textContent==='已连接' && !!document.querySelector('#stream .msg')`, 'initial fixture');
    check(await read(`!!window.piGuiDesktop?.browser && document.querySelector('#btnBrowser').hidden===false`), 'actual desktop preload');
    for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080]]) {
      win.setContentSize(width, height); await sleep(250); const size = `${width}x${height}`;
      await fetch(ORIGIN + '/api/__hotfix/no-project?value=1', { method: 'POST' });
      await win.loadURL(ORIGIN); await waitFor(`!document.querySelector('#welcomeNoProj').hidden`, 'no project');
      await shot('no-project', size);
      await fetch(ORIGIN + '/api/__hotfix/no-project?value=0', { method: 'POST' });
      await win.loadURL(ORIGIN); await waitFor(`document.querySelector('#connText').textContent==='已连接' && !!document.querySelector('#stream .msg')`, 'ready history');
      await push('/api/__conversation?what=empty'); await waitFor(`!document.querySelector('#welcomeReady').hidden && !document.querySelector('#stream .msg')`, 'empty session');
      await shot('empty-session', size);
      await push('/api/__conversation?what=long-thread&turns=24'); await waitFor(`document.querySelectorAll('#stream .msg.user').length===24`, 'long conversation');
      await shot('long-conversation', size);
      await push('/api/__push?what=running'); await waitFor(`!document.querySelector('#btnStop').hidden`, 'streaming');
      await shot('streaming', size);
      await push('/api/__composer?what=hold-stop'); await pointer('#btnStop');
      await waitFor(`document.querySelector('#statusText').textContent.includes('正在停止')`, 'stop pending');
      check(await read(`document.querySelector('#btnSend').disabled && document.querySelector('#btnStop').disabled`), size + ' stopping disables repeat/send');
      await shot('stop-pending', size); await push('/api/__composer?what=release-stop');
      await push('/api/__push?what=settled'); await waitFor(`document.querySelector('#btnStop').hidden`, 'settled');
      await push('/api/__push?what=startup-error'); await waitFor(`!document.querySelector('#stageNotice').hidden`, 'error'); await shot('error', size);
      await win.loadURL(ORIGIN); await waitFor(`document.querySelector('#connText').textContent==='已连接'`, 'recover');
      await pointer('#btnBrowser'); await waitFor(`!!document.querySelector('#browserAddress')`, 'Browser open');
      await read(`document.querySelector('#browserAddress').value=${JSON.stringify('http://127.0.0.1:')}+${fixture.address().port}`);
      await pointer('#browserAddress'); await key('Enter', 'Enter', 13); await sleep(350);
      for (let n = 0; n < 100 && controller.getWebContents()?.getTitle() !== 'P30 local preview'; n++) await sleep(50);
      check(controller.getWebContents()?.getTitle() === 'P30 local preview', size + ' native Browser loaded local fixture');
      const browserFile = `native-browser-${size}.png`;
      fs.writeFileSync(path.join(OUT, browserFile), (await controller.getWebContents().capturePage()).toPNG());
      screenshots.push(browserFile);
      await shot('browser-open', size);
      await pointer('#navChanges'); await waitFor(`!!document.querySelector('#rightPane .chg-row')`, 'Changes open');
      check(await read(`!document.querySelector('#browserViewport') && document.querySelector('#chatComposer').hidden===false`), size + ' Browser switched to Changes without replacing chat');
      await pointer('#rightPane .chg-main'); await waitFor(`!!document.querySelector('#rightPane .chg-row.open')`, 'expanded Diff');
      await shot('changes-open', size); await pointer('#rightPaneClose');
      check(await read(`document.querySelector('#rightPane').hidden && !document.querySelector('#rightPane .chg-row') && document.activeElement.id==='navChanges'`), size + ' close releases pane and returns focus');
      await shot('right-pane-closed', size);
    }
    win.setContentSize(1440, 900); await sleep(200);
    await pointer('#navGlobalMore'); await shot('settings', '1440x900');
    await key('ArrowDown', 'ArrowDown', 40); check(await read(`document.activeElement.id==='navProviderAuth'`), 'Settings arrow navigation');
    await key('Escape', 'Escape', 27); check(await read(`document.querySelector('#globalMoreMenu').hidden && document.activeElement.id==='navGlobalMore'`), 'Settings Escape focus');
    await key('k', 'KeyK', 75, 2); await waitFor(`!document.querySelector('#paletteLayer').hidden`, 'Ctrl+K');
    await key('Tab', 'Tab', 9); check(await read(`document.querySelector('#paletteLayer').contains(document.activeElement)`), 'Palette Tab stays inside');
    await key('Tab', 'Tab', 9, 8); check(await read(`document.querySelector('#paletteLayer').contains(document.activeElement)`), 'Palette Shift+Tab stays inside');
    await shot('palette', '1440x900'); await key('Escape', 'Escape', 27);
    for (const method of ['click', 'Enter']) {
      await pointer('#input'); await key('k', 'KeyK', 75, 2);
      await waitFor(`!!document.querySelector('.palette-input')`, 'Settings palette query');
      await win.webContents.debugger.sendCommand('Input.insertText', { text: '设置' });
      await waitFor(`!!document.querySelector('[data-command-id="app.preferences"]')`, 'Settings command');
      if (method === 'click') await pointer('[data-command-id="app.preferences"]');
      else await key('Enter', 'Enter', 13);
      check(await read(`!document.querySelector('#globalMoreMenu').hidden && document.activeElement.id==='navProviders'`), 'Palette Settings real ' + method + ' menu/focus handoff');
      await key('Escape', 'Escape', 27);
    }
    await pointer('.project.active .pj-row-menu-trigger'); await waitFor(`!!document.querySelector('.action-menu:not([hidden])')`, 'project menu'); await key('Escape', 'Escape', 27);
    check(await read(`document.activeElement.classList.contains('pj-row-menu-trigger')`), 'Project menu Escape focus');
    await pointer('.pj-sess:not(.pending) .pj-sess-menu-trigger'); await key('Escape', 'Escape', 27);
    check(await read(`document.activeElement.classList.contains('pj-sess-menu-trigger')`), 'Session menu Escape focus');
    await pointer('#navSearch'); await waitFor(`document.activeElement.classList.contains('pj-search-input')`, 'search focus');
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '设计' }); await sleep(350);
    check(await read(`document.querySelector('.pj-search-input').value==='设计' && document.querySelector('#projectSidebar').classList.contains('search-open')`), 'Search real input');
    await key('Escape', 'Escape', 27); check(await read(`document.querySelector('.pj-search-input').value===''`), 'Search first Escape clears query');
    await key('Escape', 'Escape', 27); check(await read(`document.activeElement.id==='navSearch'`), 'Search second Escape closes and restores focus');
    await pointer('#groupHead'); const collapsed = await read(`document.querySelector('#groupHead').getAttribute('aria-expanded')==='false'`);
    check(collapsed, 'Group collapse'); await pointer('#groupHead');
    await pointer('#btnSidebarCollapse'); check(await read(`document.activeElement.id==='btnSidebarExpand'`), 'Sidebar collapse focus');
    await key('Tab', 'Tab', 9, 8); check(await read(`document.activeElement.id==='navGlobalMore'`), 'Shift+Tab reaches Settings in collapsed shell');
    await pointer('#btnSidebarExpand'); check(await read(`document.activeElement.id==='btnSidebarCollapse'`), 'Sidebar expand focus');
    await pointer('#navPlanner'); await sleep(350); await shot('planner-review', '1440x900');
    await pointer('#navExtensions'); await waitFor(`document.querySelector('#extensionsTabSkills').getAttribute('aria-selected')==='true'`, 'Skills default'); await shot('skills', '1440x900');
    await pointer('#navHome');
    for (const zoom of [0.8, 1.25, 1.5]) {
      win.webContents.setZoomFactor(zoom); await sleep(250); await pointer('#navChanges'); await sleep(150);
      check(await read(`document.documentElement.scrollWidth<=innerWidth+1 && document.querySelector('#rightPane').getBoundingClientRect().right<=innerWidth+1`), 'Zoom ' + zoom + ' no overlap/overflow');
      await shot('zoom-' + zoom, '1440x900'); await pointer('#rightPaneClose');
    }
    win.webContents.setZoomFactor(1); await pointer('#navNew', true);
    check(await read(`getComputedStyle(document.querySelector('#navNew')).backgroundColor!=='rgba(0, 0, 0, 0)'`), 'real hover state');
    await pointer('#navGlobalMore'); await key('Tab', 'Tab', 9);
    check(await read(`document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle!=='none'`), 'real keyboard focus ring');
    check(errors.length === 0, 'renderer has no console errors');
    const report = { checks, errors, screenshots, facts, fixture: 'offline visual-harness + actual Electron/preload/browser controller', userData: 'os.tmpdir fixture' };
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(report, null, 2));
    console.log(`P30 Electron ${checks}/${checks} passed; ${screenshots.length} screenshots`);
  }
  main().catch(e => { console.error(e); exitCode = 1; }).finally(async () => {
    controller?.destroy?.(); await agent?.stop?.(); win?.destroy(); fixture?.close(); harness?.kill();
    await sleep(400); app.exit(exitCode);
  });
}
