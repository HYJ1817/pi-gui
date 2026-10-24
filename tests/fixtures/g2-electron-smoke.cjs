const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { createBrowserController } = require('../../electron/browser-view.cjs');

const ROOT = path.resolve(__dirname, '../..');
const world = process.env.G2_SMOKE_WORLD, out = process.env.G2_SMOKE_OUTPUT;
const rows = [], screenshots = [], geometry = [], errors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, value) => { assert.ok(value, name); rows.push(name); console.log('ok ' + name); };
let win, browser, agent, backend, page, origin;
app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('disable-background-networking');
async function until(action, name) {
  for (let index = 0; index < 250; index++) { if (await action()) return; await sleep(50); }
  throw new Error('timeout: ' + name);
}
const read = code => win.webContents.executeJavaScript(code, true);
async function main() {
  assert.ok(world && path.isAbsolute(world));
  assert.ok(!process.argv.includes('--no-sandbox') && !app.commandLine.hasSwitch('no-sandbox'));
  app.setPath('userData', path.join(world, 'electron'));
  const repo = path.join(world, 'repo'), data = path.join(world, 'data'), home = path.join(world, 'home');
  const pkg = path.join(world, 'node_modules/@earendil-works/pi-coding-agent');
  for (const dir of [repo, data, home, path.join(pkg, 'dist/core/extensions'), path.join(pkg, 'dist/cli')]) fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(world, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-b', 'main'); git('config', 'user.name', 'Offline fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'example.js'), 'export const fixture = true;\n');
  git('add', '.'); git('commit', '-m', 'fixture');
  fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify({ active: repo, items: [{ path: repo, name: 'G2 Offline Smoke' }] }));
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.3.0', bin: { pi: 'cli.cjs' } }));
  fs.writeFileSync(path.join(pkg, 'dist/core/extensions/types.d.ts'), '"tool_call" "tool_execution_end" getAllTools() registerTool<');
  fs.writeFileSync(path.join(pkg, 'dist/cli/args.js'), 'if (arg === "--extension") {}');
  fs.copyFileSync(path.join(ROOT, 'tests/fixtures/candidate-pi.cjs'), path.join(pkg, 'cli.cjs'));
  const shim = path.join(world, 'pi.cmd');
  fs.writeFileSync(shim, `@echo off\r\n"${process.env.G2_NODE_EXECUTABLE}" "${path.join(pkg, 'cli.cjs')}" %*\r\n`);
  const socket = require('node:net').createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), PI_GUI_DATA: data, PI_CWD: repo, PI_BIN: shim,
    PI_GUI_TOKEN: '', PI_GUI_OPEN: '0', PI_GUI_OFFLINE: '1', PI_OFFLINE: '1', PI_CODING_AGENT_DIR: path.join(home, 'agent'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  backend = spawn(process.env.G2_NODE_EXECUTABLE, [path.join(ROOT, 'server.js'), '--g2-fixture-root', world], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  backend.stdout.resume(); backend.stderr.on('data', () => {});
  await until(async () => { try { return (await (await fetch(origin + '/api/health')).json()).app === 'pi-gui'; } catch { return false; } }, 'production health');
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, done) => {
    const host = new URL(details.url).hostname;
    done({ cancel: host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' });
  });
  win = new BrowserWindow({ title: 'G2 offline desktop smoke', width: 1200, height: 820, useContentSize: true, show: true, autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: path.join(ROOT, 'electron/preload.cjs') } });
  browser = createBrowserController({ origin, getWindow: () => win, ipcMain, openExternal: async () => { throw new Error('external navigation forbidden'); } });
  browser.register();
  agent = require('../../electron/browser-agent-host.cjs').createBrowserAgentHost({ browser, origin, getWindow: () => win, ipcMain, extensionPath: path.join(ROOT, 'extensions/pi-gui-browser/index.js') });
  await agent.start();
  win.webContents.on('render-process-gone', (_event, details) => errors.push(details.reason));
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message.slice(0, 200)); });
  await win.loadURL(origin);
  await until(() => read("document.querySelector('#connText')?.textContent.includes('已连接')"), 'renderer connection');
  check('Electron starts with normal sandbox, isolated context and no Node integration', win.webContents.getLastWebPreferences().sandbox === true && win.webContents.getLastWebPreferences().contextIsolation === true && win.webContents.getLastWebPreferences().nodeIntegration === false);
  const identity = await read("import('/state.js').then(({S})=>({cwd:S.cwd,owner:S.legacyOwner,run:S.bridgeRun}))");
  check('renderer connects to the production backend and fake Pi', Number.isInteger(identity.run));
  check('workspace and owner identity belong to the temporary Git repository', path.resolve(identity.cwd) === repo && identity.owner?.workspaceId && identity.owner?.workspaceEpoch && identity.owner?.sessionId && identity.owner?.backendInstance);
  page = http.createServer((_request, response) => response.end('<!doctype html><title>G2 loopback fixture</title><h1>G2 Offline Browser</h1><input id="draft">'));
  await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
  await read("document.querySelector('#btnBrowser').click()");
  await until(() => browser.getWebContents(), 'native browser created');
  browser.navigate(`http://127.0.0.1:${page.address().port}`);
  await until(() => !browser.getState().loading && browser.getState().title === 'G2 loopback fixture', 'local page');
  // Parent capturePage does not include native child pixels. Retain the actual
  // native-page capture separately; do not fabricate a composite screenshot.
  fs.writeFileSync(path.join(out, 'smoke-native.png'), (await browser.getWebContents().capturePage()).toPNG());
  screenshots.push('smoke-native.png');
  for (const width of [1200, 760]) {
    win.setContentSize(width, 820);
    await until(async () => {
      const rect = await read("(()=>{const r=document.querySelector('#browserViewport')?.getBoundingClientRect();return r&&{x:r.x,y:r.y,width:r.width,height:r.height}})()");
      const native = win.contentView.children.find(view => view.webContents === browser.getWebContents());
      if (!rect || !native) return false;
      const bounds = native.getBounds(), zoom = win.webContents.getZoomFactor();
      const matches = ['x', 'y', 'width', 'height'].every(key => Math.abs(bounds[key] - rect[key] * zoom) <= 1);
      if (matches) geometry.push({ requestedWidth: width, contentBounds: win.getContentBounds(), viewport: rect, nativeBounds: bounds, zoom });
      return matches && bounds.width > 0 && bounds.height > 0;
    }, 'real Browser bounds ' + width);
    check(`real native Browser geometry matches renderer at ${width}px`, true);
    const name = `smoke-${width}.png`;
    fs.writeFileSync(path.join(out, name), (await win.capturePage()).toPNG()); screenshots.push(name);
  }
  await read("import('/ui/modal.js').then(m=>{m.openModal(card=>{card.textContent='G2 offline modal'})})");
  await until(() => win.contentView.children.length === 0, 'modal occlusion');
  check('real native Browser cannot cover the visible modal', await read("!document.querySelector('#modal').hidden&&document.querySelector('#modalCard').textContent==='G2 offline modal'"));
  fs.writeFileSync(path.join(out, 'smoke-modal.png'), (await win.capturePage()).toPNG()); screenshots.push('smoke-modal.png');
  await read("import('/ui/modal.js').then(m=>m.closeModal())");
  await until(() => win.contentView.children.length === 1, 'Browser restored');
  const old = browser.getWebContents(), generation = browser.getGeneration();
  await old.executeJavaScript("document.querySelector('#draft').value='stale fixture draft'");
  await read("document.querySelector('#browserClose').click()");
  await until(() => old.isDestroyed() && win.contentView.children.length === 0, 'native close cleanup');
  check('panel close destroys the native page and detaches its view', browser.getWebContents() === null);
  await read("document.querySelector('#btnBrowser').click()");
  await until(() => browser.getWebContents() && browser.getWebContents() !== old, 'fresh native page');
  check('reopen creates a fresh generation with no stale URL or document', browser.getGeneration() > generation && browser.getState().url === '');
  await read("document.querySelector('#browserClose').click()");
  await until(() => browser.getWebContents() === null, 'final panel cleanup');
  check('no renderer errors during smoke', errors.length === 0);
}
async function cleanup() {
  await agent?.stop();
  browser?.destroy(); win?.destroy();
  page?.closeAllConnections(); page?.close();
  if (backend?.exitCode === null) {
    // Use the existing Electron-parent-only shutdown protocol so the backend
    // closes its owned RPC guardian before exiting on Windows.
    const response = new Promise(resolve => backend.once('message', resolve));
    backend.send({ type: 'app-update', action: 'prepare', id: 1 });
    assert.equal((await response).ok, true, 'fixture shutdown maintenance');
    backend.send({ type: 'app-update', action: 'shutdown', id: 2 });
    await until(() => backend.exitCode !== null, 'backend exit');
  }
}
let failed = 0;
main().catch(async error => {
  failed = 1; console.error(error.stack);
  if (win && !win.isDestroyed()) {
    try { fs.writeFileSync(path.join(out, 'failure.png'), (await win.capturePage()).toPNG()); } catch { /* partial screenshot only */ }
  }
}).finally(async () => {
  fs.writeFileSync(path.join(world, 'ready-for-cleanup'), 'yes');
  try {
    await until(() => fs.existsSync(path.join(world, 'processes-observed')), 'parent process observation');
    await cleanup();
  } catch (error) { failed = 1; console.error(error.message); }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ qualification: failed ? 'failed-normal-sandbox' : 'normal-sandbox', sandbox: true, checks: rows.length, failed, skipped: 0, rows, screenshots, geometry, errors,
    electron: process.versions.electron, node: process.versions.node, platform: process.platform,
    fixture: 'temporary Git, production server/renderer/preload/Browser, existing fake Pi; loopback only; no external CDP port',
  }, null, 2) + '\n');
  app.exit(failed);
});
