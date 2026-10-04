'use strict';
// Opt-in native UI fixture. Uses product ES modules, preload, main controllers,
// and real pointer events through this window's own debugger. No CDP port.
if (!process.versions.electron) {
  if (process.env.PI_GUI_AGENT_BROWSER_LIVE !== '1') { console.log('SKIP agent-browser-ui-live (opt-in)'); process.exit(0); }
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, '--no-sandbox'], { env, stdio: 'inherit', windowsHide: true, timeout: 60000 });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBrowserController } = require('../electron/browser-view.cjs');
const { createBrowserAgentHost } = require('../electron/browser-agent-host.cjs');
let world, server, fixture, win, browser, host, checks = 0;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, name) => { assert.ok(value, name); checks++; console.log('PASS ' + name); };
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head><body>
<div class="app"><main class="stage"><header class="stage-head"><h1>P29 local browser verification</h1></header><div style="padding:20px"><label>Composer <input id="keepFocus" aria-label="Composer"></label><button id="openBrowser" class="btn">打开浏览器</button></div></main><div id="rightPaneResizer" class="rp-resizer" tabindex="0"></div><aside id="rightPane" class="right-pane" hidden><div class="rp-body"></div></aside></div><div id="toasts" class="toasts"></div>
<script type="module">import {initRightPane} from '/right-pane.js';import {attachBrowserPane} from '/browser-pane.js';import {initGuiBrowserState} from '/gui-browser-capabilities.js';window.testPane=attachBrowserPane(initRightPane());initGuiBrowserState();document.getElementById('openBrowser').onclick=()=>window.testPane.open();window.fixtureReady=true;</script></body></html>`;
async function main() {
  world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-agent-ui-'));
  app.setPath('userData', world);
  await app.whenReady();
  server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    const rel = route.slice(1);
    const file = path.resolve(__dirname, '../public', rel);
    if (!file.startsWith(path.resolve(__dirname, '../public') + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', rel.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(file));
  });
  fixture = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><h1>Local fixture page</h1><input aria-label="Name"><button>Save</button>'); });
  await Promise.all([new Promise(resolve => server.listen(0, '127.0.0.1', resolve)), new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))]);
  const origin = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ width: 1200, height: 800, show: true, webPreferences: { preload: path.resolve(__dirname, '../electron/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  browser = createBrowserController({ origin, getWindow: () => win, ipcMain }); browser.register();
  host = createBrowserAgentHost({ browser, origin, getWindow: () => win, ipcMain, extensionPath: path.resolve(__dirname, '../extensions/pi-gui-browser/index.js') }); await host.start();
  const master = host.bridge.connection();
  const post = async (route, token, body) => (await fetch(master.url + route, { method: 'POST', headers: { 'x-pi-browser-token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const session = await post('/session', master.token, { requestId: 'ui-session' });
  check(session.ok, 'real bridge session active');
  await win.loadURL(origin);
  const wc = win.webContents;
  const read = (expression) => wc.executeJavaScript(expression);
  for (let i = 0; i < 40 && !await read('window.fixtureReady===true'); i++) await sleep(50);
  check(await read('window.fixtureReady===true && !!window.piGuiDesktop.browser.agentStatus'), 'actual renderer modules and preload loaded');
  wc.debugger.attach('1.3');
  async function pointer(id) {
    const rect = await read(`(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
    await sleep(150);
  }
  await pointer('openBrowser');
  check(await read("document.getElementById('browserAgentControl').getAttribute('aria-pressed')==='false'"), 'default-off visible toolbar');
  const shots = path.resolve(__dirname, '../.shots/p29'); fs.mkdirSync(shots, { recursive: true });
  for (const width of [1200, 700]) {
    win.setContentSize(width, 720); await sleep(220);
    check(await read("document.documentElement.scrollWidth<=innerWidth+1 && (()=>{const b=document.getElementById('browserAgentControl').getBoundingClientRect();const s=document.getElementById('browserAgentStatus').getBoundingClientRect();return b.width>0&&s.right<=innerWidth&&b.bottom<=s.bottom+5})()"), `${width}px toolbar visible without overflow`);
    const off = await wc.capturePage();
    fs.writeFileSync(path.join(shots, `agent-control-off-${width}.png`), off.toPNG());
    console.log(`Screenshot ${width}px off: ${off.getSize().width}x${off.getSize().height} pixels`);
    await pointer('browserAgentControl');
    check(host.agent.status().enabled === true && await read("document.getElementById('browserAgentControl').getAttribute('aria-pressed')==='true'"), `${width}px real pointer enabled control`);
    fs.writeFileSync(path.join(shots, `agent-control-on-${width}.png`), (await wc.capturePage()).toPNG());
    await pointer('browserAgentControl');
    check(host.agent.status().enabled === false, `${width}px real pointer disabled control`);
  }
  win.setContentSize(1200, 720); await sleep(180);
  await pointer('keepFocus');
  await pointer('browserAgentControl');
  // Restore real pointer focus to composer before the Agent's open event.
  await pointer('keepFocus');
  check(await read("document.activeElement.id==='keepFocus'"), 'composer really focused before Agent action');
  const state = await post('/state', session.token, { requestId: 'ui-state' });
  const result = await post('/action', session.token, { requestId: 'ui-open', action: 'open', args: { url: `http://127.0.0.1:${fixture.address().port}/` }, epoch: state.epoch, generation: state.generation });
  check(result.ok, `Agent open through authenticated bridge (${result.code || 'ok'})`);
  check(await read("document.activeElement.id==='keepFocus' && window.testPane.surface().isLive()"), 'Agent open preserves composer focus and existing surface');
  check(browser.getWebContents().getURL().startsWith(`http://127.0.0.1:${fixture.address().port}`), 'native view loaded local fixture');
  await sleep(160);
  check(await read("document.getElementById('browserAgentStatus').textContent.includes('Agent 控制中')"), 'idle toolbar restored after Agent action');
  fs.writeFileSync(path.join(shots, 'agent-control-localhost.png'), (await wc.capturePage()).toPNG());
  // Main WebContents captures its toolbar; the native child has its own surface.
  fs.writeFileSync(path.join(shots, 'agent-control-localhost-page.png'), (await browser.getWebContents().capturePage()).toPNG());
  wc.debugger.detach();
  console.log(`agent-browser-ui-live: ${checks}/${checks} passed`);
}
async function cleanup(code) {
  try { browser?.destroy(); await host?.stop(); } catch {}
  try { server?.closeAllConnections(); server?.close(); fixture?.closeAllConnections(); fixture?.close(); win?.destroy(); } catch {}
  try { if (world) fs.rmSync(world, { recursive: true, force: true }); } catch {}
  app.exit(code);
}
main().then(() => cleanup(0), error => { console.error(error.message); cleanup(1); });
