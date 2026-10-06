// Opt-in real Electron + Git + production server. Pi/model replies are fixture
// data here; actual coding/model durability is covered separately by runtime-live.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
if (!process.versions.electron) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'p32-runtime-electron-')), env = { ...process.env, P32_RUNTIME_WORLD: world }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, '--no-sandbox', '--in-process-gpu'], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', () => { process.exitCode = 1; }); child.on('exit', code => { process.exitCode = code ?? 1; fs.rm(world, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }, () => {}); });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron'); app.on('window-all-closed', () => {});
  const ROOT = path.resolve(__dirname, '..'), world = process.env.P32_RUNTIME_WORLD, OUT = path.join(ROOT, '.shots/p32-3'), OUT4 = path.join(ROOT, '.shots/p32-4');
  let win, backend, host, browser, legacyHost, origin, checks = 0; const errors = [], screenshots = [], pages = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const check = (value, label) => { assert.ok(value, label); checks++; console.log('PASS ' + label); };
  const read = expression => win.webContents.executeJavaScript(expression, true);
  async function until(fn, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await sleep(80); } throw Error('Electron fixture timeout'); }
  async function click(selector) { const p = await read(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 }); }
  const key = (keyCode, modifiers = []) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); };
  async function shot(name, dir = OUT) { await sleep(200); const box = await read(`({w:innerWidth,h:innerHeight,sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,card:document.querySelector('#modalCard').getBoundingClientRect().toJSON()})`);
    check(box.sw <= box.w + 1 && box.sh <= box.h + 1, name + ' no page overlap/overflow'); const file = path.join(dir, name + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); screenshots.push({ file, box }); }
  async function api(body, route = '/api/runtime-sessions') { const legacy = (await (await fetch(origin + '/api/status')).json()).legacyOwner; return (await fetch(origin + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Gui-Owner': JSON.stringify(legacy) }, body: JSON.stringify(body) } : {})).json(); }
  async function main() {
    app.setPath('userData', path.join(world, 'electron')); await app.whenReady(); fs.mkdirSync(OUT, { recursive: true });
    const repo = path.join(world, 'repo'), data = path.join(world, 'data'), home = path.join(world, 'home'); for (const p of [repo, data, home]) fs.mkdirSync(p);
    const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); fs.writeFileSync(path.join(repo, 'file.txt'), 'base'); git('add', '.'); git('commit', '-m', 'base');
    fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify({ active: repo, items: [{ path: repo, name: 'Runtime Fixture' }] }));
    const pkg = path.join(world, 'node_modules/@earendil-works/pi-coding-agent'); fs.mkdirSync(path.join(pkg, 'dist/core/extensions'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.4', bin: { pi: 'cli.cjs' } }));
    fs.writeFileSync(path.join(pkg, 'dist/core/extensions/types.d.ts'), 'getAllTools() registerTool<');
    fs.mkdirSync(path.join(pkg, 'dist/cli'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'dist/cli/args.js'), 'if (arg === "--extension") {}');
    const cli = path.join(pkg, 'cli.cjs');
    fs.writeFileSync(cli, String.raw`
const fs=require('fs'),path=require('path'),crypto=require('crypto');
if(process.argv.includes('--version')){console.log('1.0.4');process.exit(0)}
const resume=process.argv.indexOf('--session'),restored=resume>=0?process.argv[resume+1]:null;
const id=restored?JSON.parse(fs.readFileSync(restored,'utf8').split('\n')[0]).id:crypto.randomUUID(),name=path.basename(process.cwd());
let streaming=false,timer;const send=v=>console.log(JSON.stringify(v));
const folder=path.join(process.env.PI_CODING_AGENT_DIR,'sessions','--'+process.cwd().replace(/[\\/:]/g,'-')+'--');fs.mkdirSync(folder,{recursive:true});
const file=restored||path.join(folder,new Date().toISOString().replace(/[:.]/g,'-')+'_'+id+'.jsonl');if(!restored)fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id,cwd:process.cwd(),timestamp:new Date().toISOString()})+'\n');
require('readline').createInterface({input:process.stdin}).on('line',line=>{
const c=JSON.parse(line);if(c.type==='prompt'&&c.message==='FIXTURE_CRASH')process.exit(7);
if(c.type==='prompt'){streaming=true;send({type:'agent_start'});send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:name+' '+c.message}});clearTimeout(timer);timer=setTimeout(()=>{streaming=false;send({type:'agent_end'});send({type:'agent_settled'});},15000);}
if(c.type==='abort'){streaming=false;clearTimeout(timer);send({type:'agent_settled'});}
send({type:'response',id:c.id,command:c.type,success:true,data:c.type==='get_state'?{sessionId:id,sessionFile:file,isStreaming:streaming,messageCount:0}:c.type==='get_messages'?{messages:[]}:c.type==='get_available_models'?{models:[]}:c.type==='get_commands'?{commands:[]}:c.type==='prompt'?{disposition:'started'}:{}});
});`);
    const piBin = path.join(world, process.platform === 'win32' ? 'pi.cmd' : 'pi');
    const trace = path.join(world, 'fixture-trace.jsonl');
    fs.writeFileSync(cli, `require('fs').appendFileSync(${JSON.stringify(trace)},JSON.stringify({event:'start',cwd:require('path').basename(process.cwd()),args:process.argv.slice(2)})+'\\n');process.on('exit',code=>require('fs').appendFileSync(${JSON.stringify(trace)},JSON.stringify({event:'exit',code})+'\\n'));\n` + fs.readFileSync(cli, 'utf8'));
    fs.writeFileSync(piBin, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 });
    const fixtureProbe = spawn(`"${piBin}" "--version"`, [], { shell: true, windowsHide: true, cwd: repo, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let probeText = ''; fixtureProbe.stdout.on('data', chunk => probeText += chunk); fixtureProbe.stderr.on('data', chunk => probeText += chunk);
    await new Promise(r => fixtureProbe.on('close', r)); assert.equal(probeText.trim(), '1.0.4', 'fixture shim launch: ' + probeText);
    assert.ok(fs.existsSync(trace), 'fixture probe must execute the owned entry, not an installed pi');
    const reserve = require('node:net').createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r)); const port = reserve.address().port; await new Promise(r => reserve.close(r)); origin = `http://127.0.0.1:${port}`;
    win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: true, autoHideMenuBar: true, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'electron/preload.cjs') } });
    browser = require('../electron/browser-view.cjs').createBrowserController({ origin, getWindow: () => win, ipcMain, isVisible: () => !host || host.isLegacyVisible() }); browser.register();
    legacyHost = require('../electron/browser-agent-host.cjs').createBrowserAgentHost({ browser, origin, getWindow: () => win, ipcMain, extensionPath: path.join(ROOT, 'extensions/pi-gui-browser/index.js') }); await legacyHost.start();
    host = require('../electron/browser-runtime-host.cjs').createRuntimeBrowserHost({ origin, getWindow: () => win, ipcMain, extensionPath: path.join(ROOT, 'extensions/pi-gui-browser/index.js'), onFocus: active => browser.setOccluded(active) }); await host.start();
    const launchBackend=()=>spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...host.environment(), PORT: String(port), PI_GUI_DATA: data, PI_CWD: repo, PI_BIN: piBin, PI_GUI_TOKEN: '', PI_GUI_OPEN: '0', PI_CODING_AGENT_DIR: path.join(home, 'agent'), HOME: home, USERPROFILE: home } });
    backend = launchBackend();
    backend.stdout.resume(); let backendErrors = ''; backend.stderr.on('data', chunk => { backendErrors = (backendErrors + chunk.toString()).slice(-2048); });
    await until(async () => { try { return (await fetch(origin + '/api/status')).ok; } catch { return false; } });
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); }); await win.loadURL(origin); win.webContents.debugger.attach('1.3');
    let bridgeStatus;
    try { await until(async () => { bridgeStatus = await api(null, '/api/status'); return bridgeStatus.state === 'ready' && await read(`!!document.querySelector('.pj-row-menu-trigger')`); }); }
    catch (error) { console.error('Fixture bridge ' + JSON.stringify({ state: bridgeStatus?.state, error: bridgeStatus?.error, hint: bridgeStatus?.hint })); console.error(backendErrors); if (fs.existsSync(trace)) console.error(fs.readFileSync(trace, 'utf8'));
      const stream = await fetch(origin + '/api/events'); const reader = stream.body.getReader(); const chunk = await reader.read(); await reader.cancel();
      for (const line of new TextDecoder().decode(chunk.value).split('\n')) if (line.startsWith('data: ')) { const event = JSON.parse(line.slice(6)); if (['bridge_stderr', 'bridge_parse_error'].includes(event.type)) console.error('Fixture diagnostic ' + JSON.stringify(event)); }
      throw error; }
    const workspaces = [];
    for (const name of ['A', 'B']) { const list = await api(null, '/api/worktrees?project=' + encodeURIComponent(repo)); const plan = await api({ action: 'prepare', project: repo, branch: 'runtime-' + name, source: 'HEAD', contextGeneration: list.contextGeneration }, '/api/worktrees'); assert.ok(plan.ok, JSON.stringify(plan)); const created = await api({ action: 'create', nonce: plan.nonce, contextGeneration: list.contextGeneration }, '/api/worktrees'); assert.ok(created.ok, JSON.stringify(created)); const next = await api(null, '/api/worktrees?project=' + encodeURIComponent(repo)); workspaces.push(next.items.find(w => w.branch === 'runtime-' + name)); }
    let started = await api({ action: 'start', args: { id: workspaces[0].id, epoch: workspaces[0].epoch } }); check(started.ok, 'A scoped child start');
    started = await api({ action: 'start', args: { id: workspaces[1].id, epoch: workspaces[1].epoch, allowThird: true } }); check(started.ok, 'B explicit third total child');
    let state; await until(async () => { state = await api(); return state.items.every(r => r.lifecycle === 'ready' && r.owner.sessionId); });
    const owners = workspaces.map(w => state.items.find(r => r.owner.workspaceId === w.id).owner);
    await read(`import('/runtime-sessions.js').then(m=>m.openRuntimeSessions({path:${JSON.stringify(repo)}}))`); await until(() => read(`document.querySelectorAll('.runtime-list .btn').length===2`));
    await api({ action: 'command', owner: owners[0], command: { type: 'prompt', message: 'TASK_A' } });
    await click('.runtime-list .btn:nth-child(2)'); await read(`document.querySelector('.runtime-body textarea').value='TASK_B';document.querySelector('.runtime-body textarea').dispatchEvent(new Event('input'))`); await click('.runtime-controls .primary');
    await until(() => read(`document.querySelector('.runtime-output').textContent.includes('TASK_B')`));
    check(await read(`!document.querySelector('.runtime-output').textContent.includes('TASK_A')`), 'A streaming focus B output isolated');
    for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080]]) { win.setContentSize(w, h); await shot(`running-B-${w}x${h}`); }
    win.webContents.setZoomFactor(1.25);await shot('running-B-zoom125');win.webContents.setZoomFactor(1);
    await click('.runtime-list .btn:first-child'); await until(() => read(`document.querySelector('.runtime-output').textContent.includes('TASK_A')`)); await click('.runtime-controls .btn:nth-child(2)');
    await until(async () => { state = await api(); return state.items.find(r => r.owner?.workspaceId === workspaces[0].id)?.activity === 'idle'; });
    check(state.items.find(r => r.owner?.workspaceId === workspaces[1].id)?.activity === 'running', 'real HTTP authoritative Stop A leaves B running'); await shot('A-stopped-B-running');
    const first = await read(`(()=>{const q=document.querySelector('#modalCard button:not([disabled])');q.focus();return q.textContent})()`); key('Tab', ['shift']); await sleep(80); check(await read(`document.querySelector('#modalCard').contains(document.activeElement)`), 'Shift Tab stays in dialog'); key('Tab'); await sleep(80); check(await read(`document.activeElement.textContent===${JSON.stringify(first)}`), 'Tab wraps to first control');
    key('Escape');await until(()=>read(`document.querySelector('#modal').hidden`));check(true,'real keyboard Escape closes scoped dialog');
    await read(`import('/runtime-sessions.js').then(m=>m.openRuntimeSessions({path:${JSON.stringify(repo)}}))`);await until(()=>read(`document.querySelectorAll('.runtime-list .btn').length===2`));
    await read(`document.querySelectorAll('.runtime-controls .btn')[4].click()`); await until(() => read(`document.querySelector('#rightPane')?.dataset.surface==='runtime-browser'`)); await shot('scoped-browser-open');
    check(host.records.size === 2, 'two Browser owner records');
    const { transport } = await import('../extensions/pi-gui-browser/index.js');
    const scopes = owners.map(({ repoId, ...scope }) => scope), snapshots = [];
    for (let i = 0; i < 2; i++) {
      const page = require('node:http').createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<h1>OWNER_${['A', 'B'][i]}</h1><button>Run</button>`); });
      pages.push(page); await new Promise(r => page.listen(0, '127.0.0.1', r));
      assert.ok((await api({ action: 'focus', owner: owners[i] })).ok);
      const scope = scopes[i]; await read(`window.piGuiDesktop.runtimeBrowser.open(${JSON.stringify(scope)})`);
      const record = [...host.records.values()].find(r => r.scope.workspaceId === owners[i].workspaceId), master = record.bridge.connection();
      const session = await transport(master, '/session', { requestId: require('crypto').randomUUID() });
      const connection = { url: master.url, token: session.token };
      const enabled = await read(`window.piGuiDesktop.runtimeBrowser.enable(${JSON.stringify(scope)},true)`); check(enabled.enabled === true, 'Browser permission owned ' + i);
      const invoke = async (action, args = {}) => { const state = await transport(connection, '/state', { requestId: require('crypto').randomUUID() }); return transport(connection, '/action', { requestId: require('crypto').randomUUID(), action, args, epoch: state.epoch, generation: state.generation }); };
      const opened = await invoke('open', { url: `http://127.0.0.1:${page.address().port}` }); check(opened.ok, 'Browser Agent localhost open ' + i);
      snapshots.push(await invoke('snapshot'));
      check(JSON.stringify(snapshots[i]).includes('OWNER_' + ['A', 'B'][i]) && !JSON.stringify(snapshots[i]).includes('OWNER_' + ['B', 'A'][i]), 'actual CDP snapshot scope ' + i);
      const denied = await invoke('open', { url: 'https://example.com/' }); check(denied.ok === false, 'P29 remote permission remains denied ' + i);
      if (i === 0) { const shot = await invoke('screenshot'); check(shot.ok && shot.image?.mimeType === 'image/png', 'actual scoped CDP screenshot'); }
    }
    // Restore A, whose toolbar is mounted, before using its close button.
    await api({ action: 'focus', owner: owners[0] });
    await click('#browserClose'); await until(() => read(`document.querySelector('#rightPane').hidden`)); await shot('scoped-browser-closed');
    await read(`import('/runtime-sessions.js').then(m=>m.openRuntimeSessions({path:${JSON.stringify(repo)}}))`);await until(()=>read(`document.querySelectorAll('.runtime-list .btn').length===2`));
    await api({action:'command',owner:owners[1],command:{type:'prompt',message:'B_SURVIVES_CRASH'}});
    await api({action:'command',owner:owners[0],command:{type:'prompt',message:'FIXTURE_CRASH'}});
    await until(async()=>{state=await api();return state.items.find(r=>r.conversationId===owners[0].conversationId)?.lifecycle==='error';});
    check(state.items.find(r=>r.conversationId===owners[1].conversationId).activity==='running','A Pi crash does not stop B');
    await until(()=>read(`document.querySelector('.runtime-body .modal-desc').textContent.includes('错误')`));check(true,'crash state visible in selected A');await shot('A-crashed-B-running');
    const crashed=state.items.find(r=>r.conversationId===owners[0].conversationId).owner;
    const restartResult=await api({action:'restart',owner:crashed});assert.ok(restartResult.ok,JSON.stringify(restartResult));check(true,'restart crashed A through owned cleanup');
    await until(async()=>{state=await api();const a=state.items.find(r=>r.conversationId===owners[0].conversationId);return a.lifecycle==='ready'&&a.owner?.sessionId===owners[0].sessionId;});
    const resumed=state.items.find(r=>r.conversationId===owners[0].conversationId).owner;
    check(resumed.runtimeGeneration!==owners[0].runtimeGeneration&&resumed.runtimeId!==owners[0].runtimeId,'restart keeps native session and rotates runtime identity');
    check(!(await api({action:'command',owner:owners[0],command:{type:'prompt',message:'STALE'}})).ok,'old A owner cannot write restarted child');

    /* ---- P32.4-A：项目会话区里的并行会话（真实 Electron + 真实后端） ----
     * 侧栏读的是 registry 快照 + worktrees 归属，不 spawn；点击只改 focus。 */
    fs.mkdirSync(OUT4, { recursive: true });
    /* 关掉 P32.3 的窄入口 modal —— P32.4 的验收对象是**侧栏**，modal 开着会挡住它。 */
    await read(`import('/ui/modal.js').then(m=>m.closeModal())`); await sleep(200);
    await read(`import('/sessions.js').then(m=>m.refreshSidebarSessions())`);
    await until(()=>read(`document.querySelectorAll('#pjRuntimeList [data-conversation-id]').length===2`),60000);
    check(true,'P32.4 sidebar lists both parallel conversations');
    check(await read(`!!document.querySelector('#pjRuntimeList .pj-runtime-new')`),'P32.4 sidebar offers 新建并行会话');
    check(await read(`!/runtimeId|runtimeGeneration|workspaceEpoch/.test(document.querySelector('#pjRuntimeList').textContent)`),'P32.4 sidebar hides runtime debug identity');
    check(await read(`!/(backendInstance|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4})/.test(document.querySelector('#pjRuntimeList').textContent)`),'P32.4 sidebar shows no raw ids');
    const liveBefore = (await api()).liveCount;
    const orderBefore = await read(`[...document.querySelectorAll('#pjRuntimeList [data-conversation-id]')].map(r=>r.dataset.conversationId).join(',')`);
    await read(`document.querySelector('#pjRuntimeList [data-conversation-id]').querySelector('button').click()`);
    await until(async()=>{state=await api();return !!state.focusedConversationId;},30000);
    const orderAfter = await read(`[...document.querySelectorAll('#pjRuntimeList [data-conversation-id]')].map(r=>r.dataset.conversationId).join(',')`);
    check(orderAfter === orderBefore,'P32.4 clicking a conversation does not reorder the sidebar');
    check((await api()).liveCount === liveBefore,'P32.4 clicking a conversation neither spawns nor stops a runtime');
    await shot('sidebar-a-running-b-focused', OUT4);
    for (const [w, h] of [[1280, 800], [1920, 1080]]) { win.setContentSize(w, h); await shot(`sidebar-${w}x${h}`, OUT4); }
    win.webContents.setZoomFactor(1.25); await shot('sidebar-zoom125', OUT4); win.webContents.setZoomFactor(1);
    win.setContentSize(1440, 900);
    await api({ action: 'close', owner: resumed }); await api({ action: 'close', owner: owners[1] }); state = await api(); check(state.liveCount === 0 && state.items.length === 2, 'close cleanup retains lazy records');
    /* 关闭 Runtime 之后：会话仍在侧栏、显示为已关闭，且**没有**任何 child 被启动。 */
    await read(`import('/ui/modal.js').then(m=>m.closeModal())`); await sleep(200);
    await read(`import('/sessions.js').then(m=>m.refreshSidebarSessions())`);
    await until(()=>read(`document.querySelectorAll('#pjRuntimeList [data-conversation-id]').length===2`),30000);
    check(await read(`document.querySelectorAll('#pjRuntimeList [data-conversation-id]').length===2 && document.querySelector('#pjRuntimeList').textContent.includes('已关闭')`),'P32.4 closed runtimes stay visible as dormant rows');
    await shot('sidebar-dormant', OUT4);
    const oldBackend=state.backendInstance;
    await new Promise(resolve=>{backend.once('exit',resolve);backend.kill();});
    backend=launchBackend();backend.stdout.resume();backend.stderr.resume();
    await until(async()=>{try{state=await api();return state.backendInstance!==oldBackend&&state.items.length===2;}catch{return false;}});
    check(state.liveCount===0&&state.items.every(r=>r.lifecycle==='dormant'&&!r.owner),'backend restart discovers disk sessions without spawning scoped children');
    check(!(await api({action:'command',owner:resumed,command:{type:'prompt',message:'OLD_BACKEND'}})).ok,'old backend identity cannot operate restored registry');
    await win.loadURL(origin);
    check((await api({action:'resume',conversationId:owners[0].conversationId})).ok,'resume revalidates Git worktree and proven native session file');
    await until(async()=>{state=await api();const a=state.items.find(r=>r.conversationId===owners[0].conversationId);return a.lifecycle==='ready'&&a.owner?.sessionId===owners[0].sessionId;});
    const recovered=state.items.find(r=>r.conversationId===owners[0].conversationId).owner;
    check(recovered.backendInstance!==owners[0].backendInstance&&recovered.sessionId===owners[0].sessionId,'disk recovery keeps native session and allocates fresh backend owner');
    await api({action:'close',owner:recovered});

    /* P32.4-A 闭环：在临时真实 Git 项目里，从**侧栏**点「新建并行会话」走完整条链
     * （真实 worktree prepare/create + 真实 runtime start），并确认新行出现、Runtime 真的起来。
     * 这一段专门盯住 askBranchName 的「创建并启动」是否回传真实分支名 —— 曾经写成
     * finish(null)，按钮看着能点、实际什么都不发生。 */
    await read(`import('/sessions.js').then(m=>m.refreshSidebarSessions())`);
    await until(() => read(`document.querySelectorAll('#pjRuntimeList [data-conversation-id]').length===2`), 30000);
    const rowsBefore = await read(`document.querySelectorAll('#pjRuntimeList [data-conversation-id]').length`);
    const recordsBefore = (await api()).items.length;
    await read(`document.querySelector('#pjRuntimeList .pj-runtime-new').click()`);
    await until(() => read(`!!document.querySelector('#modalCard input') && !document.querySelector('#modal').hidden`), 20000);
    await read(`(()=>{const i=document.querySelector('#modalCard input');i.value='p32-4-ui-loop';i.dispatchEvent(new Event('input'));})()`);
    await read(`[...document.querySelectorAll('#modalCard button')].find(b=>b.textContent==='创建并启动').click()`);
    /* 必须等到 **ready** 再取 owner：registry 在 child 就绪时会轮换
     * runtimeGeneration（见 runtime-registry 的 emit），在 starting 阶段捕获的
     * owner 随后就是 stale_runtime。 */
    await until(async () => { state = await api(); const rec = state.items.find(i => i.workspace.branch === 'p32-4-ui-loop');
      return state.items.length === recordsBefore + 1 && rec?.lifecycle === 'ready' && typeof rec.owner?.sessionId === 'string'; }, 120000);
    check(state.liveCount === 1, 'P32.4 sidebar create loop actually started a runtime');
    const createdOwner = state.items.find(i => i.owner && i.workspace.branch === 'p32-4-ui-loop')?.owner;
    check(Boolean(createdOwner), 'P32.4 created conversation carries the entered branch name');
    await read(`import('/sessions.js').then(m=>m.refreshSidebarSessions())`);
    await until(() => read(`document.querySelectorAll('#pjRuntimeList [data-conversation-id]').length===${rowsBefore + 1}`), 30000);
    check(true, 'P32.4 new parallel conversation appears in the sidebar after creation');
    check(await read(`document.querySelector('#pjRuntimeList').textContent.includes('p32-4-ui-loop')`), 'P32.4 new sidebar row shows its branch name');
    await shot('sidebar-created', OUT4);
    /* 收尾只做尽力而为的关闭：close 的权威语义由 P32.3 段断言，这里失败也不该
     * 让「创建闭环」这一段的结论失真。 */
    const closed = await api({ action: 'close', owner: createdOwner });
    check(closed.ok === true, 'P32.4 created runtime can be closed through its owned handle');
    assert.deepEqual(errors,[], 'renderer console errors');check(true, 'no renderer console errors');
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ checks, platform: process.platform, electron: process.versions.electron, screenshots, errors }, null, 2)); console.log(`Runtime Electron ${checks}/${checks}; ${screenshots.length} screenshots`);
  }
  async function finish(code) { try { backend?.kill(); await host?.stop(); await legacyHost?.stop(); browser?.destroy(); for (const page of pages) { page.closeAllConnections(); page.close(); } win?.destroy(); } catch {} setTimeout(() => app.exit(code), 500); }
  /* 失败时把渲染进程 console 错误与 modal 状态一起打出来 —— 否则
   * 「Script failed to execute」这类错误只能看到 Electron 的包装信息，定位不到根因。 */
  main().then(() => finish(0), async error => { console.error(error); console.error('renderer console errors: ' + JSON.stringify(errors)); try { console.error('modal state: ' + JSON.stringify(await read(`({open: !document.querySelector('#modal').hidden, listBtns: document.querySelectorAll('.runtime-list .btn').length})`))); } catch (e) { console.error('modal unreadable: ' + e.message); } await finish(1); });
}
