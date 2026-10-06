// Opt-in: real Git + production HTTP server + Electron/Chromium, all data in os.tmpdir.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
if (!process.versions.electron) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'p32-electron-'));
  const env = { ...process.env, P32_WORLD: world }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, '--no-sandbox', '--in-process-gpu'], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', e => { console.error(e); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; fs.rm(world, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }, e => { if (e) console.error(e.code); }); });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, '.shots/p32-2'), world = process.env.P32_WORLD;
  const repo = path.join(world, 'repo'), data = path.join(world, 'data'), home = path.join(world, 'home');
  let win, backend, backendEnv, origin, controller, agent, checks = 0, generation, workspaceA, workspaceB;
  const shots = [], errors = []; app.on('window-all-closed', () => {}); app.setPath('userData', path.join(world, 'electron'));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function check(value, name) { if (!value) throw Error(name); checks++; console.log('PASS ' + name); }
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(world, 'gitconfig') } }).trim();
  const read = code => win.webContents.executeJavaScript(code);
  async function until(code, name) { for (let i = 0; i < 150; i++) { if (await read(code)) return; await sleep(100); } throw Error('Timeout ' + name); }
  async function click(selector) {
    win.focus(); await read(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest'})`); await sleep(100);
    const p = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing/enabled ${selector}');const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p });
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p }); await sleep(100);
  }
  const key = (keyCode, modifiers = []) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); };
  const list = async () => (await fetch(origin + '/api/worktrees?project=' + encodeURIComponent(repo))).json();
  async function manager() { await click('.pj-row-menu-trigger'); await until(`!!document.querySelector('#actionMenu')`, 'project menu'); await click('#actionMenu .action-menu-item'); await until(`document.querySelector('.wt-list')?.textContent.includes('主工作区')`, 'manager'); }
  async function create(branch) {
    await read(`document.querySelectorAll('.wt-form input')[1].value=${JSON.stringify(branch)}`); await click('.wt-form .primary');
    await until(`!document.querySelector('#confirmLayer').hidden`, 'risk confirm');
    check(await read(`document.querySelector('#confirmCard').textContent.includes('未提交') && document.querySelector('#confirmCard').textContent.includes('stash/reset')`), 'dirty-main risk visible');
    await click('#confirmCard .primary'); await until(`!document.querySelector('.wt-form .primary').disabled`, 'create completed');
    const result = await list(); generation = result.contextGeneration; const created = result.items.find(w => w.branch === branch);
    if (!created) throw Error('Create rejected: ' + await read(`document.querySelector('.wt-notice').textContent`)); return created;
  }
  async function shot(name, size) {
    await sleep(150); const dimensions = await read(`({width:innerWidth,height:innerHeight,sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,card:document.querySelector('#modalCard').getBoundingClientRect().toJSON()})`);
    check(dimensions.sw <= dimensions.width + 1 && dimensions.sh <= dimensions.height + 1, name + ' page no overflow');
    if (await read(`!document.querySelector('#modal').hidden`)) check(dimensions.card.x >= 0 && dimensions.card.y >= 0 && dimensions.card.right <= dimensions.width + 1 && dimensions.card.bottom <= dimensions.height + 1, name + ' dialog inside viewport');
    const file = path.join(OUT, `${name}-${size}.png`); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); shots.push({ name, file, dimensions });
  }
  async function main() {
    fs.mkdirSync(repo); fs.mkdirSync(data); fs.mkdirSync(home); fs.mkdirSync(OUT, { recursive: true });
    git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(repo, 'file.txt'), 'base'); git('add', '.'); git('commit', '-m', 'base'); fs.writeFileSync(path.join(repo, 'dirty.txt'), 'main dirty retained');
    fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify({ active: repo, items: [{ path: repo, name: 'P32 Fixture' }] }));
    const fakePi = path.join(world, 'pi-fixture.cjs');
    fs.writeFileSync(fakePi, `if(process.argv.includes('--version')){console.log('1.0.4');process.exit(0)}if(!process.argv.includes('--mode'))process.exit(0);require('node:readline').createInterface({input:process.stdin}).on('line',line=>{let q;try{q=JSON.parse(line)}catch{return}const data=q.type==='get_state'?{isStreaming:false,sessionId:'fixture',messageCount:0,pendingMessageCount:0}:q.type==='get_messages'?{messages:[]}:q.type==='get_available_models'?{models:[]}:q.type==='get_commands'?{commands:[]}:{};console.log(JSON.stringify({type:'response',id:q.id,command:q.type,success:true,data}));});`);
    const piBin = path.join(world, process.platform === 'win32' ? 'pi-fixture.cmd' : 'pi-fixture');
    fs.writeFileSync(piBin, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${fakePi}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fakePi}" "$@"\n`, { mode: 0o755 });
    const reserve = require('node:net').createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r)); const port = reserve.address().port; await new Promise(r => reserve.close(r)); origin = `http://127.0.0.1:${port}`;
    backendEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), PI_GUI_DATA: data, PI_CWD: repo, PI_BIN: piBin, PI_GUI_TOKEN: '', PI_GUI_OPEN: '0', HOME: home, USERPROFILE: home };
    backend = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: backendEnv });
    let logs = ''; backend.stdout.on('data', b => { logs += b; }); backend.stderr.on('data', b => { logs += b; });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(origin + '/api/status')).ok) break; } catch {} await sleep(100); if (i === 99) throw Error('Server startup ' + logs.slice(-800)); }
    await app.whenReady(); win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: true, autoHideMenuBar: true, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'electron/preload.cjs') } });
    controller = require('../electron/browser-view.cjs').createBrowserController({ origin, getWindow: () => win, ipcMain }); controller.register();
    agent = require('../electron/browser-agent-host.cjs').createBrowserAgentHost({ browser: controller, origin, getWindow: () => win, ipcMain, extensionPath: path.join(ROOT, 'extensions/pi-gui-browser/index.js') }); await agent.start();
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3 && !message.includes('Electron Security Warning')) errors.push(message); });
    await win.loadURL(origin); win.webContents.debugger.attach('1.3');
    await until(`document.querySelector('#connText').textContent==='已连接'`, 'fixture Pi ready');
    await until(`!!document.querySelector('.project.active .pj-row-menu-trigger')`, 'authoritative active project'); await manager();
    win.setContentSize(1440, 900); await sleep(200);
    await shot('main-only', '1440x900');
    await click('.wt-form .primary'); await until(`!document.querySelector('#confirmLayer').hidden`, 'risk'); await shot('create-risk', '1440x900'); key('Escape'); await sleep(100);
    check((await list()).items.length === 1, 'Escape risk cancel creates nothing');
    workspaceA = await create('pi-gui/live-a'); workspaceB = await create('pi-gui/live-b');
    check(workspaceA && workspaceB && workspaceA.path !== workspaceB.path, 'A/B real Git distinct worktree paths');
    check(fs.readFileSync(path.join(repo, 'dirty.txt'), 'utf8') === 'main dirty retained' && !fs.existsSync(path.join(workspaceA.path, 'dirty.txt')), 'dirty main unchanged/not copied');
    for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080]]) { win.setContentSize(w, h); await shot('workspaces', `${w}x${h}`); }
    win.setContentSize(1280, 800); win.webContents.setZoomFactor(1.25); await shot('zoom-125', '1280x800'); win.webContents.setZoomFactor(1); win.setContentSize(1440, 900); await sleep(400);
    await click('.wt-row:nth-child(2) .row-action-trigger'); await until(`!!document.querySelector('#actionMenu')`, 'workspace menu');
    check(await read(`(()=>{const e=document.querySelector('#actionMenu'),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+12))})()`), 'menu receives hit test above modal');
    key('Escape'); await sleep(100); check(await read(`!document.querySelector('#modal').hidden && !document.querySelector('#actionMenu') && document.activeElement.classList.contains('row-action-trigger')`), 'Escape menu retains dialog + focus');
    await read(`document.querySelector('.wt-form .primary').focus()`); key('Tab'); await sleep(100); check(await read(`document.activeElement.textContent==='关闭'`), 'Tab wraps inside dialog'); key('Tab', ['shift']); await sleep(100); check(await read(`document.activeElement.classList.contains('primary')`), 'Shift+Tab wraps inside dialog');
    await click('.wt-row:nth-child(2) .btn'); await until(`document.querySelector('#modal').hidden`, 'opened');
    for (let i = 0; i < 50; i++) { const p = await (await fetch(origin + '/api/projects')).json(); if (p.cwd === workspaceA.cwd) { check(p.items.length === 1 && p.active === repo, 'open uses backend cwd, stable single parent row'); break; } await sleep(100); if (i === 49) throw Error('open did not activate'); }
    await manager(); await shot('current-worktree', '1440x900'); await click('.wt-row:first-child .btn'); await until(`document.querySelector('#modal').hidden`, 'main open');
    await until(`import('/state.js').then(({S})=>S.cwd===${JSON.stringify(repo)} && S.bridgeState==='ready' && !S.switching)`, 'main runtime ready'); await manager();
    await click('.wt-row:nth-child(3) .row-action-trigger'); await click('#actionMenu .action-menu-item:first-child'); await until(`document.querySelector('.wt-list').textContent.includes('已归档')`, 'archived'); await shot('archived', '1440x900');
    check(fs.existsSync(workspaceB.path), 'archive retains files');
    check(await read(`document.querySelector('#modal').contains(document.activeElement)`), 'archive async refresh keeps focus inside dialog');
    fs.writeFileSync(path.join(workspaceA.path, 'keep.txt'), 'dirty A');
    await click('.wt-row:nth-child(2) .row-action-trigger'); await click('#actionMenu .action-menu-item:last-child'); await until(`!document.querySelector('#confirmLayer').hidden`, 'remove confirm'); await click('#confirmCard .danger');
    await until(`document.querySelector('.wt-notice').textContent.includes('未提交')`, 'dirty refusal'); await shot('dirty-remove-refused', '1440x900'); check(fs.existsSync(path.join(workspaceA.path, 'keep.txt')), 'dirty removal leaves bytes');
    git('worktree', 'remove', '--force', workspaceA.path); key('Escape'); await sleep(100); await manager(); await until(`document.querySelector('.wt-list').textContent.includes('丢失')`, 'missing'); await shot('externally-missing', '1440x900');
    await read(`document.querySelectorAll('.wt-form input')[1].value='pi-gui/live-b'`); await click('.wt-form .primary'); await until(`document.querySelector('.wt-notice').textContent.includes('分支已存在')`, 'branch conflict'); await shot('branch-conflict', '1440x900');
    key('Escape'); await sleep(100); check(await read(`document.activeElement.classList.contains('pj-row-menu-trigger')`), 'dialog Escape restores project menu trigger');
    check(errors.length === 0, 'no renderer JS errors');
    await agent.stop(); agent = null; backend.kill(); await new Promise(resolve => backend.once('exit', resolve));
    backend = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...backendEnv, PI_CWD: '' } });
    backend.stdout.resume(); backend.stderr.resume();
    let restored;
    for (let i = 0; i < 100; i++) { try { const r = await list(); if (r.ok) { restored = r; break; } } catch {} await sleep(100); }
    check(restored?.items.some(w => w.id === workspaceB.id && w.archived && w.health === 'healthy'), 'real backend restart rediscovers archived B');
    check(restored?.items.some(w => w.id === workspaceA.id && w.health === 'missing'), 'real backend restart keeps missing A, no path reclaim');
    const status = await (await fetch(origin + '/api/projects')).json(); check(status.cwd === repo && status.items.length === 1, 'restart restores authoritative main cwd/parent order');
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ checks, platform: process.platform, electron: process.versions.electron, screenshots: shots, errors }, null, 2));
    console.log(`P32.2 Electron: ${checks}/${checks} passed; ${shots.length} screenshots; ${OUT}`);
  }
  main().then(() => teardown(0), async e => { console.error(e); try { console.error('UI fixture: ' + await read(`document.querySelector('#modalCard').textContent`)); } catch {} teardown(1); });
  async function teardown(code) { try { await agent?.stop?.(); controller?.destroy?.(); win?.destroy(); } catch {} if (backend && !backend.killed) backend.kill(); setTimeout(() => app.exit(code), 500); }
}
