'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createBrowserController } = require('../electron/browser-view.cjs');
const { createBrowserAgentHost } = require('../electron/browser-agent-host.cjs');
let fixture, win, browser, host, world;
let checks = 0;
function check(condition, name) { assert.ok(condition, name); checks++; console.log('PASS ' + name); }
async function main() {
  world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-p29-live-'));
  app.setPath('userData', world);
  await app.whenReady();
  fixture = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route === '/missing') { res.writeHead(404); res.end('missing'); return; }
    if (route === '/ok') { res.end('ok'); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>P29 localhost fixture</title><style>body{font:20px system-ui;padding:30px}input,button{font:inherit;margin:12px;padding:12px}</style><h1>Local development verification</h1><button onclick="document.getElementById('state').textContent='clicked';console.log('fixture-click')">Save</button><label>Username<input aria-label="Username" oninput="document.getElementById('value').textContent=this.value" onkeydown="if(event.key==='Enter')document.getElementById('state').textContent='entered'"></label><textarea aria-label="Notes">old</textarea><div id="state">ready</div><div id="value"></div><script>console.log('fixture-ready');fetch('/ok?secret=hidden');fetch('/missing?secret=hidden')</script>`);
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  win = new BrowserWindow({ width: 1050, height: 750, show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  browser = createBrowserController({ origin: 'http://127.0.0.1:7788', getWindow: () => win, ipcMain });
  browser.register();
  host = createBrowserAgentHost({ browser, origin: 'http://127.0.0.1:7788', getWindow: () => win,
    ipcMain, extensionPath: path.resolve(__dirname, '../extensions/pi-gui-browser/index.js') });
  await host.start();
  check(host.agent.status().enabled === false, 'default disabled');
  const disabled = await host.agent.execute({ requestId: 'disabled', action: 'open', args: { url } });
  check(disabled.code === 'agent_control_disabled', 'disabled actions rejected');
  const connection = host.bridge.connection();
  const activation = await fetch(connection.url + '/session', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pi-Browser-Token': connection.token },
    body: JSON.stringify({ requestId: 'live-session' }) }).then(r => r.json());
  check(activation.ok, 'dedicated bridge session activation');
  process.env.PI_GUI_BROWSER_URL = connection.url;
  process.env.PI_GUI_BROWSER_TOKEN = activation.token;
  const adapter = await import(pathToFileURL(path.resolve(__dirname, '../extensions/pi-gui-browser/index.js')).href);
  const tools = new Map();
  adapter.default({ registerTool: tool => tools.set(tool.name, tool) });
  delete process.env.PI_GUI_BROWSER_URL; delete process.env.PI_GUI_BROWSER_TOKEN;
  check(tools.size === 12, 'bundled extension registers distinct tool namespace');
  await host.agent.setEnabled(true);
  const call = async (action, args = {}) => {
    const result = await tools.get('gui_browser_' + action).execute(`live-${++serial}`, args);
    const image = result.content.find(item => item.type === 'image');
    if (image) {
      check(!JSON.stringify(result.details).includes(image.data), 'pixels omitted from tool details');
      return { ...result.details, image: { data: image.data, mimeType: image.mimeType } };
    }
    return result.details;
  };
  let serial = 0;
  check((await call('open', { url })).ok, 'open local fixture and wait for load');
  // Product bounds path: use registered IPC with a fixture rectangle, never a CDP port.
  browser.setBounds?.({ x: 0, y: 0, width: 1000, height: 680 });
  const wc = browser.getWebContents();
  await new Promise(resolve => setTimeout(resolve, 250));
  const snapshot = await call('snapshot');
  check(snapshot.ok && snapshot.elements.some((x) => x.role === 'button'), 'AX snapshot button ref');
  check(new Set(snapshot.elements.map((x) => x.ref)).size === snapshot.elements.length, 'refs unique');
  const button = snapshot.elements.find((x) => x.role === 'button' && x.name === 'Save');
  const input = snapshot.elements.find((x) => x.name === 'Username' && x.role === 'textbox');
  check((await call('click', { ref: button.ref })).ok, 'real pointer click');
  await new Promise(resolve => setTimeout(resolve, 100));
  check((await wc.executeJavaScript("document.getElementById('state').textContent")) === 'clicked', 'click changed DOM');
  check((await call('fill', { ref: input.ref, text: 'hello fixture' })).ok, 'fill input');
  check((await wc.executeJavaScript("document.getElementById('value').textContent")) === 'hello fixture', 'input event reached page');
  check((await call('press', { key: 'Enter' })).ok, 'press Enter');
  check((await wc.executeJavaScript("document.getElementById('state').textContent")) === 'entered', 'Enter changed DOM');
  const screenshot = await call('screenshot');
  check(screenshot.ok && screenshot.image?.mimeType === 'image/png' && screenshot.image.data.length > 100, 'real CDP PNG screenshot');
  const shots = path.resolve(__dirname, '../.shots/p29'); fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, 'localhost-loop.png'), Buffer.from(screenshot.image.data, 'base64'));
  const consoleResult = await call('console');
  check(consoleResult.ok && JSON.stringify(consoleResult).includes('fixture-click'), 'console real event');
  const network = await call('network');
  check(network.ok && JSON.stringify(network).includes('404') && JSON.stringify(network).includes('/ok'), 'network success + 404');
  check(!JSON.stringify(network).includes('secret=hidden'), 'network strips query');
  check((await call('reload')).ok, 'reload completed');
  check((await call('click', { ref: button.ref })).code === 'stale_element_ref', 'old ref stale after reload');
  check((await call('open', { url: 'https://example.com' })).code === 'remote_origin_not_allowed', 'remote rejected without network');
  host.agent.invalidate();
  check((await call('status')).ok !== false, 'status after cancellation');
  browser.close();
  check(!host.agent.status().attached, 'close detaches debugger');
  console.log(`agent-browser-live: ${checks}/${checks} passed`);
}
main().then(() => cleanup(0), (error) => { console.error(error.message); cleanup(1); });
async function cleanup(code) {
  try { browser?.destroy(); await host?.stop(); } catch { /* exiting */ }
  try { fixture?.closeAllConnections(); fixture?.close(); win?.destroy(); } catch { /* exiting */ }
  try { if (world) fs.rmSync(world, { recursive: true, force: true }); } catch { /* Chromium may hold files until exit */ }
  app.exit(code);
}
