'use strict';
// Real native-view fixture. No Pi, model, user project or remote web requests.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
if (!process.versions.electron) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-t2b-native-'));
  const env = { ...process.env, T2B_WORLD: world }; delete env.ELECTRON_RUN_AS_NODE;
  const args = [__filename];
  if (env.T2B_TEST_NO_SANDBOX === '1') args.push('--no-sandbox');
  const result = spawnSync(require('electron'), args, { env, stdio: 'inherit', windowsHide: true, timeout: 240000 });
  try { fs.rmSync(world, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain, session, webContents } = require('electron');
const http = require('node:http'), assert = require('node:assert/strict');
const { createBrowserController, isBrowserWebContents } = require('../electron/browser-view.cjs');
const { createBrowserAgentHost } = require('../electron/browser-agent-host.cjs');
const { createRuntimeBrowserHost } = require('../electron/browser-runtime-host.cjs');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.T2B_EVIDENCE_DIR || path.join(ROOT, 'docs/evidence/t2-b-browser-workbench'));
let win, server, pageServer, browser, agent, runtimeHost, checks = 0;
const rows = [], shots = [], sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (name, value) => { assert.ok(value, name); checks++; rows.push(name); console.log('PASS ' + name); };
const until = async (fn, name) => { for (let i = 0; i < 150; i++) { if (await fn()) return; await sleep(40); } throw Error('Timeout: ' + name); };
const scope = id => ({ backendInstance: 'fixture', runtimeId: id, runtimeGeneration: 'g', projectId: 'project', workspaceId: id, workspaceEpoch: 'e', conversationId: id, sessionId: id });
const fixtureModule = `
import {S} from '/state.js';
import {initRightPane} from '/right-pane.js';
import {configureSecondaryPane} from '/ui/secondary-surface.js';
import {attachBrowserPane} from '/browser-pane.js';
import {openSplitWorkbench} from '/ui/split-workbench.js';
import {createRuntimeSecondary} from '/runtime-secondary.js';
import {runtimeStore} from '/runtime-state.js';
import {setGitConversationScope} from '/api.js';
S.workspaceGeneration=1;S.switching=false;S.bridgeState='ready';
document.getElementById('projectSidebar').hidden=true;
const pane=initRightPane();configureSecondaryPane(pane);
const browser=attachBrowserPane(pane,{openWorkbench:openSplitWorkbench});
const runtime=createRuntimeSecondary({pane});
const spec={transport:{index:async()=>({ok:true,workspace:{id:'fixture',generation:'1'},documents:[{id:'1'.repeat(32),path:'SPEC.md',bytes:10}]}),document:async()=>({ok:true,document:{id:'1'.repeat(32),path:'SPEC.md',content:'# Fixture specs'}})}};
window.test={pane,browser,runtime,store:runtimeStore,setGitConversationScope,specs:()=>openSplitWorkbench({specsOptions:spec})};
window.fixtureReady=true;
`;
async function post(connection, route, body, header = 'X-Pi-Browser-Token') {
  return (await fetch(connection.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', [header]: connection.token }, body: JSON.stringify(body) })).json();
}
async function main() {
  const world = process.env.T2B_WORLD;
  assert.ok(world && path.isAbsolute(world)); app.setPath('userData', path.join(world, 'user-data'));
  await app.whenReady(); fs.mkdirSync(OUT, { recursive: true });
  const project = path.join(world, 'project'); fs.mkdirSync(project);
  const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(world, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(project, 'example.js'), 'const value = 1;\n'); git('add', '.'); git('commit', '-m', 'fixture');
  fs.writeFileSync(path.join(project, 'example.js'), 'const value = 2;\n');
  const worktreeB = path.join(world, 'worktree-b'); git('worktree', 'add', '-b', 'fixture/b', worktreeB);
  fs.writeFileSync(path.join(project, 'workspace.txt'), 'A'); fs.writeFileSync(path.join(worktreeB, 'workspace.txt'), 'B');
  pageServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const workspace = req.url === '/B' ? fs.readFileSync(path.join(worktreeB, 'workspace.txt'), 'utf8') : fs.readFileSync(path.join(project, 'workspace.txt'), 'utf8');
    res.end(`<!doctype html><style>body{font:16px sans-serif;padding:16px;background:#eef2ef;color:#24342a}input,button{font:inherit;max-width:90%}article{height:600px}</style><h1>Local preview ${req.url === '/two' ? 'Two' : 'One'}</h1><p>Temporary worktree ${workspace}</p><input id="draft" aria-label="Preview draft"><button id="save" onclick="this.textContent='Saved'">Save</button><p><a href="/two">Second page</a></p><article>Browser content scrolls independently.</article>`);
  });
  await new Promise(r => pageServer.listen(0, '127.0.0.1', r));
  server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      const id = req.headers['x-pi-gui-conversation'] || 'classic';
      if (route === '/api/git/status') return res.end(JSON.stringify({ ok: true, isRepo: true, files: [{ path: `${id}-example.js`, status: 'M', additions: 1, deletions: 1 }] }));
      if (route === '/api/git/diff') return res.end(JSON.stringify({ ok: true, working: git('diff'), staged: '', binary: false, truncated: false }));
      return res.end(JSON.stringify({ ok: true }));
    }
    if (route === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fixtureModule); }
    const file = path.resolve(ROOT, 'public', route === '/' ? 'index.html' : '.' + route);
    if (!file.startsWith(path.join(ROOT, 'public') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8');
    let data = fs.readFileSync(file); if (route === '/') data = data.toString().replace('src="/app.js"', 'src="/fixture.js"'); res.end(data);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`, page = `http://127.0.0.1:${pageServer.address().port}`;
  win = new BrowserWindow({ title: 'T2-B native verification', width: 1200, height: 850, useContentSize: true, show: true,
    webPreferences: { preload: path.join(ROOT, 'electron/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  browser = createBrowserController({ origin, getWindow: () => win, ipcMain, isVisible: () => !runtimeHost || runtimeHost.isLegacyVisible() }); browser.register();
  agent = createBrowserAgentHost({ browser, origin, getWindow: () => win, ipcMain, extensionPath: path.join(ROOT, 'extensions/pi-gui-browser/index.js') }); await agent.start();
  runtimeHost = createRuntimeBrowserHost({ origin, getWindow: () => win, ipcMain, onFocus: flag => browser.setOccluded(flag) }); await runtimeHost.start();
  await win.loadURL(origin); const read = code => win.webContents.executeJavaScript(code, true);
  await until(() => read('window.fixtureReady===true'), 'renderer ready');
  const native = () => win.contentView.children.find(v => v.webContents === browser.getWebContents());
  const boundsMatch = async () => {
    const r = await read(`(()=>{const r=document.getElementById('browserViewport')?.getBoundingClientRect();return r&&{x:r.x,y:r.y,width:r.width,height:r.height}})()`), v = native();
    if (!r || !v) return false; const b = v.getBounds(), z = win.webContents.getZoomFactor();
    return ['x', 'y', 'width', 'height'].every(k => Math.abs(b[k] - r[k] * z) <= 1);
  };
  const shot = async name => {
    await sleep(180);
    // Keep actual renderer and native-page captures separate; never composite them.
    fs.writeFileSync(path.join(OUT, name + '.png'), (await win.capturePage()).toPNG()); shots.push(name + '.png');
    const child = win.contentView.children.find(v => v.webContents);
    if (child) { fs.writeFileSync(path.join(OUT, name + '-native-page.png'), (await child.webContents.capturePage()).toPNG()); shots.push(name + '-native-page.png'); }
  };
  await read('test.browser.open()'); await until(() => browser.getWebContents(), 'native creation'); browser.navigate(page);
  await until(() => browser.getState().url === page + '/' && !browser.getState().loading, 'local page');
  await until(boundsMatch, 'single bounds'); check('single Browser has valid native viewport', true);
  await read("document.getElementById('browserAddress').blur()");
  await shot('01-browser-single');
  const wc = browser.getWebContents(), identity = wc.id;
  await wc.executeJavaScript("document.getElementById('draft').value='retained fixture draft'");
  await read('test.browser.openSplit()'); await until(boundsMatch, 'split bounds');
  await until(() => read("!!document.querySelector('.workbench-pane-browser')&&!!document.querySelector('.chg-main')"), 'Changes loaded');
  check('Browser and Changes simultaneously visible', await read("!!document.querySelector('.workbench-pane-browser')&&!!document.querySelector('.chg-main')"));
  check('single to split preserves native page and form', wc.id === identity && await wc.executeJavaScript("document.getElementById('draft').value==='retained fixture draft'"));
  await read("document.querySelector('.chg-main').click()"); await sleep(150);
  check('Diff expansion renders actual Git patch without replacing Browser', browser.getWebContents().id === identity && await read("!document.querySelector('.chg-diff').hidden&&document.querySelector('.chg-diff').textContent.includes('value = 2')"));
  const activation = await post(agent.bridge.connection(), '/session', { requestId: 't2b-session' });
  check('Agent Control starts disabled with a real isolated bridge session', activation.ok && agent.agent.status().enabled === false);
  await agent.agent.setEnabled(true);
  const snapshot = await agent.agent.execute({ requestId: 't2b-snapshot', action: 'snapshot', args: {} });
  const input = snapshot.elements?.find(e => e.role === 'textbox');
  const fill = await agent.agent.execute({ requestId: 't2b-fill', action: 'fill', args: { ref: input?.ref, text: 'Agent fixture draft' } });
  check('Agent Control fills local native page in split', fill.ok && await wc.executeJavaScript("document.getElementById('draft').value==='Agent fixture draft'"));
  await agent.agent.setEnabled(false);
  check('explicit disable rejects further Agent page actions', (await agent.agent.execute({ requestId: 't2b-disabled', action: 'snapshot', args: {} })).code === 'agent_control_disabled');
  const pageButton = await wc.executeJavaScript("(()=>{const r=document.getElementById('save').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
  wc.sendInputEvent({ type: 'mouseDown', ...pageButton, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', ...pageButton, button: 'left', clickCount: 1 });
  await until(() => wc.executeJavaScript("document.getElementById('save').textContent==='Saved'"), 'native page pointer click');
  check('actual native-page pointer remains interactive in split', true);
  for (const width of [1536, 1200, 900, 720]) {
    win.setContentSize(width, 850); await sleep(180); await until(boundsMatch, 'resize bounds ' + width);
    check(`${width}px native view matches visible viewport`, true);
    check(`${width}px no horizontal document overflow`, await read('document.documentElement.scrollWidth<=innerWidth+1'));
    await shot('02-browser-changes-' + width);
  }
  await read("document.querySelector('[data-workbench-tab=changes]').click()"); await until(() => !native(), 'fallback detach');
  check('Changes fallback really detaches native Browser', true); await shot('03-narrow-changes');
  await read("document.querySelector('[data-workbench-tab=browser]').click()"); await until(boundsMatch, 'fallback restore');
  check('Browser tab restores same native page', browser.getWebContents().id === identity);
  win.setContentSize(1200, 850); await sleep(150);
  const splitter = await read("(()=>{const r=document.querySelector('.workbench-splitter').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  const old = native().getBounds().height;
  win.webContents.sendInputEvent({ type: 'mouseDown', ...splitter, button: 'left', clickCount: 1 }); await sleep(80);
  check('native Browser detaches during actual pointer drag', !native());
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(splitter.x), y: Math.round(splitter.y - 60) });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(splitter.x), y: Math.round(splitter.y - 60), button: 'left', clickCount: 1 });
  await until(boundsMatch, 'drag restore'); check('pointer drag updates Browser bounds', native().getBounds().height !== old);
  for (let i = 0; i < 3; i++) {
    const point = await read("(()=>{const r=document.querySelector('.workbench-splitter').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 }); await sleep(20);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y + (i % 2 ? -35 : 35) });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y + (i % 2 ? -35 : 35), button: 'left', clickCount: 1 });
    await until(boundsMatch, 'repeated drag');
  }
  check('repeated actual drags keep one correctly bounded native view', win.contentView.children.length === 1);
  await read("document.querySelector('.workbench-splitter').focus()");
  const keyboardBefore = native().getBounds().height;
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
  await sleep(80); await until(boundsMatch, 'keyboard bounds');
  check('keyboard resizing updates native bounds and persists shared ratio', native().getBounds().height !== keyboardBefore && await read("Number.isFinite(JSON.parse(localStorage.getItem('pi-gui.workbench.split.v1')).ratio)"));
  await read("document.getElementById('modal').hidden=false"); await until(() => !native(), 'modal detach');
  check('modal excludes native Browser', true); await shot('04-modal-occlusion');
  await read("document.getElementById('modal').hidden=true"); await until(boundsMatch, 'modal restore');
  win.webContents.setZoomFactor(1.25); await sleep(200); await until(boundsMatch, 'zoom bounds');
  check('125 percent app zoom converts CSS to native DIP', true); await shot('05-zoom-125');
  win.webContents.setZoomFactor(1); win.setContentSize(1200, 420); await sleep(200);
  check('short window degrades to tabs', await read("document.querySelector('.workbench-split').classList.contains('is-fallback')"));
  await shot('06-short-window'); win.setContentSize(1200, 850); await sleep(150); await until(boundsMatch, 'height restore');
  browser.navigate(page + '/two'); await until(() => browser.getState().canGoBack && !browser.getState().loading, 'second page');
  browser.command('back'); await until(() => browser.getState().url === page + '/' && !browser.getState().loading, 'back');
  browser.command('forward'); await until(() => browser.getState().url === page + '/two' && !browser.getState().loading, 'forward');
  browser.command('reload'); await until(() => !browser.getState().loading, 'reload'); check('back forward and reload retain same native page', browser.getWebContents().id === identity);
  check('preview session is not GUI default session', wc.session !== session.defaultSession);
  for (let i = 0; i < 20; i++) { await read("document.getElementById('browserSplit').click()"); await read('test.browser.openSplit()'); }
  await until(boundsMatch, 'twenty transitions'); check('twenty layout switches retain exactly one native view', win.contentView.children.length === 1 && browser.getWebContents().id === identity);
  await read('void test.specs()'); await until(() => !browser.getWebContents(), 'Specs transition closes classic Browser');
  check('Specs workbench remains functional and native Browser removed', await read("!!document.querySelector('#workbenchSpecsPane')"));
  for (let i = 0; i < 20; i++) {
    await read('test.browser.openSplit()'); await until(boundsMatch, 'reopen cycle');
    check(`native reopen cycle ${i + 1} has one view`, win.contentView.children.length === 1);
    await read("document.getElementById('browserClose').click()");
    await until(() => browser.getWebContents() === null && win.contentView.children.length === 0, 'native close cycle');
  }
  check('twenty real reopen and close cycles leave no native view', win.contentView.children.length === 0);
  await until(() => webContents.getAllWebContents().every(wc => !isBrowserWebContents(wc)), 'closed native webContents released');
  check('twenty native close cycles leave no hidden browser webContents', true);
  const env = runtimeHost.environment(), connection = { url: env.PI_GUI_RUNTIME_BROWSER_URL, token: env.PI_GUI_RUNTIME_BROWSER_TOKEN };
  for (const id of ['A', 'B']) await post(connection, '/action', { action: 'allocate', scope: scope(id) }, 'X-Pi-Runtime-Browser-Token');
  await read(`test.store.seed({backendInstance:'fixture',items:${JSON.stringify(['A', 'B'].map(id => ({ conversationId: id, owner: { ...scope(id), repoId: 'r' }, lifecycle: 'ready', activity: 'idle', workspace: { branch: id } })))}})`);
  for (const id of ['A', 'B', 'A']) {
    await post(connection, '/action', { action: 'focus', scope: scope(id) }, 'X-Pi-Runtime-Browser-Token');
    await read(`test.setGitConversationScope('${id}');test.runtime.focus('${id}');test.runtime.openBrowserSplit()`);
    const record = [...runtimeHost.records.values()].find(r => r.scope.conversationId === id); record.controller.navigate(page + '/' + id);
    await until(() => win.contentView.children.some(v => v.webContents === record.controller.getWebContents()), 'runtime native ' + id);
    await until(() => !record.controller.getState().loading, 'runtime page loaded ' + id);
    check(`focused ${id} displays its real temporary Worktree page`, await record.controller.getWebContents().executeJavaScript(`document.body.textContent.includes('Temporary worktree ${id}')`));
    check(`focused ${id} has only its own native view`, win.contentView.children.length === 1 && [...runtimeHost.records.values()].filter(r => r.scope.conversationId !== id).every(r => !win.contentView.children.some(v => v.webContents === r.controller.getWebContents())));
    check(`focused ${id} Changes is scoped`, await read(`document.querySelector('.chg-path').textContent.startsWith('${id}-')`));
    await shot('07-focused-' + id);
  }
  const records = [...runtimeHost.records.values()]; check('runtime A and B have distinct nondefault sessions', records[0].controller.getWebContents().session !== records[1].controller.getWebContents().session && records.every(r => r.controller.getWebContents().session !== session.defaultSession));
  const closingPage = records[0].controller.getWebContents();
  await post(connection, '/action', { action: 'dispose', scope: scope('A') }, 'X-Pi-Runtime-Browser-Token');
  check('session close destroys its native page', records[0].controller.getWebContents() === null);
  await until(() => closingPage.isDestroyed(), 'session native page destroyed');
  check('disposed session has no live hidden webContents', true);
  await read('test.pane.close()'); check('closing workbench leaves no attached native views', win.contentView.children.length === 0);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, failed: 0, rows, shots, electron: process.versions.electron,
    sandboxQualification: process.env.T2B_TEST_NO_SANDBOX === '1' ? 'not verified: isolated fixture uses --no-sandbox' : 'normal startup',
    fixture: 'production modules/CSS/preload/native controllers; temporary Git fixture, HTTP status adapter, two real runtime Browser scopes; no real Pi or model' }, null, 2));
  console.log(`Browser workbench Electron: ${checks}/${checks}; ${OUT}`);
}
main().then(() => cleanup(0), async error => { console.error(error.stack); try { fs.writeFileSync(path.join(OUT, 'failure.json'), JSON.stringify({ checks, error: error.message, rows }, null, 2)); } catch {} await cleanup(1); });
async function cleanup(code) {
  try { await runtimeHost?.stop(); await agent?.stop(); browser?.destroy(); win?.destroy(); } catch {}
  try { server?.closeAllConnections(); server?.close(); pageServer?.closeAllConnections(); pageServer?.close(); } catch {}
  app.exit(code);
}
