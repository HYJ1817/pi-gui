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
  async function read(expression) {
    let timer;
    const moduleName = /import\('([^']+)'/.exec(expression)?.[1] || 'DOM operation';
    try { return await Promise.race([win.webContents.executeJavaScript(expression, true), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Electron renderer operation timeout: ' + moduleName)), 120000); })]); }
    finally { clearTimeout(timer); }
  }
  async function until(fn, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await sleep(80); } throw Error('Electron fixture timeout'); }
  /* 点击前先把目标滚进可视区再取坐标：modal 卡片是可滚动的，元素被滚出卡片时
   * 它的 rect 落在卡片之外 —— 点下去命中的是**遮罩**，于是 modal 被关掉，
   * 后续断言只会说「元素是 null」，离根因很远。 */
  async function click(selector) { const p = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('click target missing: '+${JSON.stringify(selector)});e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect();if(r.width<1||r.height<1)throw new Error('click target not laid out: '+${JSON.stringify(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 }); }
  const key = (keyCode, modifiers = []) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); };
  async function shot(name, dir = OUT) { await sleep(200); const box = await read(`({w:innerWidth,h:innerHeight,sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,card:document.querySelector('#modalCard').getBoundingClientRect().toJSON()})`);
    check(box.sw <= box.w + 1 && box.sh <= box.h + 1, name + ' no page overlap/overflow'); const file = path.join(dir, name + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); screenshots.push({ file, box }); }
  async function api(body, route = '/api/runtime-sessions') { const legacy = (await (await fetch(origin + '/api/status')).json()).legacyOwner; return (await fetch(origin + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Gui-Owner': JSON.stringify(legacy) }, body: JSON.stringify(body) } : {})).json(); }
  async function main() {
    app.setPath('userData', path.join(world, 'electron')); await app.whenReady(); fs.mkdirSync(OUT, { recursive: true });
    const repo = path.join(world, 'repo'), data = path.join(world, 'data'), home = path.join(world, 'home'); for (const p of [repo, data, home]) fs.mkdirSync(p);
    const appData = path.join(home, 'AppData', 'Roaming'), localAppData = path.join(home, 'AppData', 'Local'), fixtureTmp = path.join(world, 'tmp');
    for (const p of [appData, localAppData, fixtureTmp]) fs.mkdirSync(p, { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'core.autocrlf', 'false'); git('config', 'core.eol', 'lf');
    fs.writeFileSync(path.join(repo, 'file.txt'), 'base');
    for (const name of ['a-only.txt', 'b-only.txt']) fs.writeFileSync(path.join(repo, name), 'base\n');
    fs.writeFileSync(path.join(repo, 'worker.cjs'), `const label=process.argv[2];const server=require('http').createServer((_q,r)=>r.end(label));server.listen(0,'127.0.0.1',()=>{console.log('READY '+server.address().port);console.log('PROCESS_'+label);});setInterval(()=>console.log('TICK_'+label),500);`);
    git('add', '.'); git('commit', '-m', 'base');
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
const fixtureModels=[{provider:'fixture',id:'reason-a',name:'Fixture Reason A',reasoning:true,input:['text'],contextWindow:64000,maxTokens:4096},{provider:'fixture',id:'text-b',name:'Fixture Text B',reasoning:false,input:['text']},{provider:'fixture',id:'unknown',name:'Fixture Unknown',input:['text']},{provider:'fixture',id:'delayed',name:'Fixture Delayed',reasoning:true,input:['text']},{provider:'fixture',id:'reject',name:'Fixture Rejected',reasoning:true,input:['text']}];
const branch=require('child_process').execFileSync('git',['branch','--show-current'],{encoding:'utf8',windowsHide:true}).trim();
let currentModel=fixtureModels[branch==='runtime-B'?1:0],thinkingLevel='low',readbackUntil=0;
const folder=path.join(process.env.PI_CODING_AGENT_DIR,'sessions','--'+process.cwd().replace(/[\\/:]/g,'-')+'--');fs.mkdirSync(folder,{recursive:true});
const file=restored||path.join(folder,new Date().toISOString().replace(/[:.]/g,'-')+'_'+id+'.jsonl');if(!restored)fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id,cwd:process.cwd(),timestamp:new Date().toISOString()})+'\n');
const nativeMessages=()=>fs.readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(e=>e.type==='message').map(e=>e.message);
const appendMessage=(role,text)=>{const entries=fs.readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line));const parent=entries.findLast(e=>e.type!=='session'&&e.id)?.id||null;fs.appendFileSync(file,JSON.stringify({type:'message',id:crypto.randomUUID(),parentId:parent,timestamp:new Date().toISOString(),message:{role,content:[{type:'text',text}],timestamp:Date.now(),...(role==='assistant'?{api:'openai-completions',provider:currentModel.provider,model:currentModel.id,stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}:{})}})+'\n');};
require('readline').createInterface({input:process.stdin}).on('line',async line=>{
const c=JSON.parse(line);if(c.type==='prompt'&&c.message==='FIXTURE_CRASH')process.exit(7);
if(c.type==='set_model'){
  const next=fixtureModels.find(m=>m.provider===c.provider&&m.id===c.modelId);
  await new Promise(r=>setTimeout(r,650));
  if(!next||next.id==='reject'){send({type:'response',id:c.id,command:c.type,success:false,error:'Fixture model rejected'});return;}
  currentModel=next;thinkingLevel=next.reasoning===true?'low':'off';readbackUntil=Date.now()+650;
  send({type:'response',id:c.id,command:c.type,success:true,data:next});return;
}
if(c.type==='set_thinking_level'){await new Promise(r=>setTimeout(r,450));thinkingLevel=c.level;send({type:'response',id:c.id,command:c.type,success:true,data:{level:thinkingLevel}});return;}
if(c.type==='get_state'&&Date.now()<readbackUntil)await new Promise(r=>setTimeout(r,readbackUntil-Date.now()));
if(c.type==='prompt'&&c.message.startsWith('FIXTURE_PROCESS_START ')){
  // The fixture Pi consumes its private capability exactly as the extension does.
  // Credentials stay in this child environment and never enter RPC/output/files.
  const call=async(endpoint,body)=>{const r=await fetch(process.env.PI_GUI_PROCESS_URL+endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Pi-Process-Token':process.env.PI_GUI_PROCESS_TOKEN},body:JSON.stringify({...body,requestId:crypto.randomUUID()})});return r.json();};
  const diagnostic=value=>fs.appendFileSync(process.env.P32_FIXTURE_PROCESS_DIAGNOSTICS,JSON.stringify({label:c.message.split(' ')[1],hasUrl:Boolean(process.env.PI_GUI_PROCESS_URL),hasToken:Boolean(process.env.PI_GUI_PROCESS_TOKEN),...value})+'\n');
  try{const state=await call('/state',{}),result=await call('/action',{action:'start',generation:state.generation,args:{command:'node',args:['worker.cjs',c.message.split(' ')[1]],ready:{type:'log',marker:'READY',timeoutMs:10000}}});
  diagnostic({stateOk:state.ok,stateCode:state.code,resultOk:result.ok,resultCode:result.code,processState:result.process?.state});
  send({type:'response',id:c.id,command:c.type,success:result.ok===true,data:{disposition:'started'}});}catch(error){diagnostic({errorName:error.name});send({type:'response',id:c.id,command:c.type,success:false,data:{code:'fixture_bridge_failed'}});}return;
}
if(c.type==='prompt'){appendMessage('user',c.message);appendMessage('assistant',name+' '+c.message);streaming=true;send({type:'agent_start'});send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:name+' '+c.message}});clearTimeout(timer);timer=setTimeout(()=>{streaming=false;send({type:'agent_end'});send({type:'agent_settled'});},15000);}
if(c.type==='abort'){streaming=false;clearTimeout(timer);send({type:'agent_settled'});}
send({type:'response',id:c.id,command:c.type,success:true,data:c.type==='get_state'?{sessionId:id,sessionFile:file,isStreaming:streaming,messageCount:nativeMessages().length,model:currentModel,thinkingLevel}:c.type==='get_messages'?{messages:nativeMessages()}:c.type==='get_available_models'?{models:fixtureModels}:c.type==='get_available_thinking_levels'?{levels:currentModel.reasoning===true?['off','low','high']:[]}:c.type==='get_commands'?{commands:[]}:c.type==='prompt'?{disposition:'started'}:{}});
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
    const timingFile = path.join(OUT4, process.env.P32_RUNTIME_CLASSIC_SHOT === '1' ? 'electron-classic-timing.jsonl' : 'electron-timing.jsonl'), timingHook = path.join(world, 'timing.cjs');
    fs.mkdirSync(OUT4, { recursive: true }); fs.writeFileSync(timingFile, '');
    fs.writeFileSync(timingHook, `const fs=require('fs'),cp=require('child_process'),http=require('http');const log=v=>fs.appendFileSync(${JSON.stringify(timingFile)},JSON.stringify(v)+'\\n');const spawn=cp.spawn;cp.spawn=function(command,args,options){const start=Date.now(),child=spawn.call(this,command,args,options);if(/^(git|git.exe)$/.test(require('path').basename(command))){log({kind:'git-start',pid:child.pid,operation:args[0]});child.once('close',code=>log({kind:'git-close',pid:child.pid,operation:args[0],ms:Date.now()-start,code}));}return child};require('module').syncBuiltinESMExports();const create=http.createServer;http.createServer=function(...args){const server=create.apply(this,args);server.prependListener('request',(req,res)=>{const start=Date.now(),route=new URL(req.url,'http://127.0.0.1').pathname;log({kind:'http-start',route});res.once('finish',()=>log({kind:'http-finish',route,ms:Date.now()-start,status:res.statusCode}));});return server};`);
    const processDiagnostics = path.join(world, 'process-diagnostics.jsonl');
    const launchBackend=()=>spawn(process.execPath, ['--require', timingHook, path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...host.environment(), P32_FIXTURE_PROCESS_DIAGNOSTICS: processDiagnostics, PORT: String(port), PI_GUI_DATA: data, PI_CWD: repo, PI_BIN: piBin, PI_GUI_TOKEN: '', PI_GUI_OPEN: '0', PI_CODING_AGENT_DIR: path.join(home, 'agent'), HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData, TEMP: fixtureTmp, TMP: fixtureTmp, TMPDIR: fixtureTmp } });
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
    if (process.env.P32_RUNTIME_CLASSIC_SHOT === '1') {
      await until(() => read(`!document.querySelector('#pjSessionsBox').textContent.includes('读取会话')`));
      await shot('classic-ui', OUT4);
      check(errors.length === 0, 'classic capture has no renderer console errors');
      fs.writeFileSync(path.join(OUT4, 'classic-report.json'), JSON.stringify({ mode: 'classic-capture-only', checks, screenshots, errors, platform: process.platform, electron: process.versions.electron }, null, 2));
      console.log(`Runtime Electron classic capture ${checks}/${checks}; ${screenshots.length} screenshots`); return;
    }
    const workspaces = [];
    for (const name of ['A', 'B']) { const list = await api(null, '/api/worktrees?project=' + encodeURIComponent(repo)); const plan = await api({ action: 'prepare', project: repo, branch: 'runtime-' + name, source: 'HEAD', contextGeneration: list.contextGeneration }, '/api/worktrees'); assert.ok(plan.ok, JSON.stringify(plan)); const created = await api({ action: 'create', nonce: plan.nonce, contextGeneration: list.contextGeneration }, '/api/worktrees'); assert.ok(created.ok, JSON.stringify(created)); const next = await api(null, '/api/worktrees?project=' + encodeURIComponent(repo)); workspaces.push(next.items.find(w => w.branch === 'runtime-' + name)); }
    let started = await api({ action: 'start', args: { id: workspaces[0].id, epoch: workspaces[0].epoch } }); check(started.ok, 'A scoped child start');
    started = await api({ action: 'start', args: { id: workspaces[1].id, epoch: workspaces[1].epoch, allowThird: true } }); check(started.ok, 'B explicit third total child');
    let state; await until(async () => { state = await api(); return state.items.every(r => r.lifecycle === 'ready' && r.owner.sessionId); });
    const owners = workspaces.map(w => state.items.find(r => r.owner.workspaceId === w.id).owner);
    await read(`import('/runtime-sessions.js').then(m=>m.openRuntimeSessions({path:${JSON.stringify(repo)}}))`); await until(() => read(`document.querySelectorAll('#modalCard .runtime-list .btn').length===2`));
    await api({ action: 'command', owner: owners[0], command: { type: 'prompt', message: 'TASK_A' } });
    await read(`document.querySelector('#modalCard .runtime-list .btn:nth-child(2)').click()`);
    await until(() => read(`document.querySelector('#modalCard .runtime-body .wt-name').textContent.includes('runtime-B')`));
    await read(`document.querySelector('#modalCard .runtime-body textarea').value='TASK_B';document.querySelector('#modalCard .runtime-body textarea').dispatchEvent(new Event('input'))`);
    await click('#modalCard .runtime-controls .primary');
    await until(() => read(`document.querySelector('#modalCard .runtime-output').textContent.includes('TASK_B')`));
    check(await read(`!document.querySelector('#modalCard .runtime-output').textContent.includes('TASK_A')`), 'A streaming focus B output isolated');
    for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080]]) { win.setContentSize(w, h); await shot(`running-B-${w}x${h}`); }
    win.webContents.setZoomFactor(1.25);await shot('running-B-zoom125');win.webContents.setZoomFactor(1);
    await read(`document.querySelector('#modalCard .runtime-list .btn:first-child').click()`);
    await until(() => read(`document.querySelector('#modalCard .runtime-body .wt-name').textContent.includes('runtime-A') && document.querySelector('#modalCard .runtime-output').textContent.includes('TASK_A')`)); await click('#modalCard .runtime-controls .btn:nth-child(2)');
    await until(async () => { state = await api(); return state.items.find(r => r.owner?.workspaceId === workspaces[0].id)?.activity === 'idle'; });
    check(state.items.find(r => r.owner?.workspaceId === workspaces[1].id)?.activity === 'running', 'real HTTP authoritative Stop A leaves B running'); await shot('A-stopped-B-running');
    const first = await read(`(()=>{const q=document.querySelector('#modalCard button:not([disabled])');q.focus();return q.textContent})()`); key('Tab', ['shift']); await sleep(80); check(await read(`document.querySelector('#modalCard').contains(document.activeElement)`), 'Shift Tab stays in dialog'); key('Tab'); await sleep(80); check(await read(`document.activeElement.textContent===${JSON.stringify(first)}`), 'Tab wraps to first control');
    key('Escape');await until(()=>read(`document.querySelector('#modal').hidden`));check(true,'real keyboard Escape closes scoped dialog');
    await read(`import('/runtime-sessions.js').then(m=>m.openRuntimeSessions({path:${JSON.stringify(repo)}}))`);await until(()=>read(`document.querySelectorAll('#modalCard .runtime-list .btn').length===2`));
    await read(`document.querySelectorAll('#modalCard .runtime-controls .btn')[4].click()`); await until(() => read(`document.querySelector('#rightPane')?.dataset.surface==='runtime-browser'`)); await shot('scoped-browser-open');
    check(host.records.size === 2, 'two Browser owner records');
    const { transport } = await import('../extensions/pi-gui-browser/index.js');
    const scopes = owners.map(({ repoId, ...scope }) => scope), snapshots = [];
    for (let i = 0; i < 2; i++) {
      const page = require('node:http').createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<style>html{color-scheme:dark}body{background:#151515;color:#f5f5f5;font:16px system-ui;padding:16px}button{padding:6px 12px}</style><h1>OWNER_${['A', 'B'][i]}</h1><button>Run</button>`); });
      pages.push(page); await new Promise(r => page.listen(0, '127.0.0.1', r));
      assert.ok((await api({ action: 'focus', owner: owners[i] })).ok);
      await read(`import('/runtime-sessions.js').then(m=>m.openRuntimeSessions({path:${JSON.stringify(repo)}}))`);
      await until(() => read(`document.querySelectorAll('#modalCard .runtime-list .btn').length===2`));
      await read(`document.querySelectorAll('#modalCard .runtime-list .btn')[${i}].click()`);
      await read(`[...document.querySelectorAll('#modalCard .runtime-controls button')].find(b=>b.textContent==='Browser').click()`);
      await until(() => read(`document.querySelector('#workspace').dataset.workspaceView==='runtime'&&(document.querySelector('#runtimeView .rtc-title')?.textContent||'').includes('runtime-${['A', 'B'][i]}')`));
      await read(`[...document.querySelectorAll('#runtimeView button')].find(b=>b.textContent==='Browser').click()`);
      const scope = scopes[i]; await read(`window.piGuiDesktop.runtimeBrowser.open(${JSON.stringify(scope)})`);
      const record = [...host.records.values()].find(r => r.scope.workspaceId === owners[i].workspaceId), master = record.bridge.connection();
      // Focus is now bound by the central surface asynchronously. Wait for its
      // real native rectangle before asking CDP for viewport-dependent work.
      await until(() => win.contentView.children.some(v => v.webContents === record.controller.getWebContents()));
      const session = await transport(master, '/session', { requestId: require('crypto').randomUUID() });
      const connection = { url: master.url, token: session.token };
      const enabled = await read(`window.piGuiDesktop.runtimeBrowser.enable(${JSON.stringify(scope)},true)`); check(enabled.enabled === true, 'Browser permission owned ' + i);
      const invoke = async (action, args = {}) => { const state = await transport(connection, '/state', { requestId: require('crypto').randomUUID() }); return transport(connection, '/action', { requestId: require('crypto').randomUUID(), action, args, epoch: state.epoch, generation: state.generation }); };
      const opened = await invoke('open', { url: `http://127.0.0.1:${page.address().port}` }); check(opened.ok, 'Browser Agent localhost open ' + i);
      snapshots.push(await invoke('snapshot'));
      check(JSON.stringify(snapshots[i]).includes('OWNER_' + ['A', 'B'][i]) && !JSON.stringify(snapshots[i]).includes('OWNER_' + ['B', 'A'][i]), 'actual CDP snapshot scope ' + i);
      const denied = await invoke('open', { url: 'https://example.com/' }); check(denied.ok === false, 'P29 remote permission remains denied ' + i);
      if (i === 0) { const shot = await invoke('screenshot'); check(shot.ok && shot.image?.mimeType === 'image/png', 'actual scoped CDP screenshot' + (shot.code ? ': ' + shot.code : '')); }
    }
    // Restore A, whose toolbar is mounted, before using its close button.
    await api({ action: 'focus', owner: owners[0] });
    await read(`import('/runtime-sessions.js').then(m=>m.openRuntimeSessions({path:${JSON.stringify(repo)}}))`);
    await until(() => read(`document.querySelectorAll('#modalCard .runtime-list .btn').length===2`));
    await read(`document.querySelector('#modalCard .runtime-list .btn').click()`);
    await read(`[...document.querySelectorAll('#modalCard .runtime-controls button')].find(b=>b.textContent==='Browser').click()`);
    await until(() => { const r = [...host.records.values()].find(r => r.scope.workspaceId === owners[0].workspaceId); return win.contentView.children.some(v => v.webContents === r.controller.getWebContents()); });
    await click('#browserClose'); await until(() => read(`document.querySelector('#rightPane').hidden`)); await shot('scoped-browser-closed');
    await read(`import('/runtime-sessions.js').then(m=>m.openRuntimeSessions({path:${JSON.stringify(repo)}}))`);await until(()=>read(`document.querySelectorAll('#modalCard .runtime-list .btn').length===2`));
    await api({action:'command',owner:owners[1],command:{type:'prompt',message:'B_SURVIVES_CRASH'}});
    await api({action:'command',owner:owners[0],command:{type:'prompt',message:'FIXTURE_CRASH'}});
    await until(async()=>{state=await api();return state.items.find(r=>r.conversationId===owners[0].conversationId)?.lifecycle==='error';});
    check(state.items.find(r=>r.conversationId===owners[1].conversationId).activity==='running','A Pi crash does not stop B');
    await until(()=>read(`document.querySelector('#modalCard .runtime-body .modal-desc').textContent.includes('错误')`));check(true,'crash state visible in selected A');await shot('A-crashed-B-running');
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

    /* ---- P32.4-B：侧栏点一行 → 中央切到那条会话，草稿按会话隔离 ---- */
    const rowSel = id => `#pjRuntimeList [data-conversation-id="${id}"] button`;
    const centerBranch = () => read(`document.querySelector('#runtimeView .rtc-head .rtc-title')?.textContent || ''`);
    const centerDraft = () => read(`document.querySelector('#runtimeView textarea')?.value ?? null`);
    const clickRow = id => read(`document.querySelector('${rowSel(id)}').click()`);
    const [idA, idB] = await read(`[...document.querySelectorAll('#pjRuntimeList [data-conversation-id]')].map(r=>r.dataset.conversationId)`);
    await clickRow(idA);
    await until(() => read(`document.querySelector('#workspace').dataset.workspaceView === 'runtime'
      && (document.querySelector('#runtimeView .rtc-head .rtc-title')?.textContent||'').includes('runtime-A')`), 20000);
    check(true, 'P32.4-B sidebar focus switches the centre to that conversation');
    check(await read(`!document.querySelector('#runtimeView').hidden && document.querySelector('#chatView').hidden`), 'P32.4-B centre hides the classic chat while a parallel conversation is focused');
    await read(`(()=>{const t=document.querySelector('#runtimeView textarea');t.value='draft-A-live';t.dispatchEvent(new Event('input'));})()`);
    await shot('sidebar-focus-a', OUT4);
    await clickRow(idB);
    await until(async () => (await centerBranch()).includes('runtime-B'), 20000);
    check((await centerDraft()) === '', 'P32.4-B switching to B shows an empty draft (A draft does not leak)');
    await read(`(()=>{const t=document.querySelector('#runtimeView textarea');t.value='draft-B-live';t.dispatchEvent(new Event('input'));})()`);
    await clickRow(idA);
    await until(async () => (await centerBranch()).includes('runtime-A'), 20000);
    check((await centerDraft()) === 'draft-A-live', 'P32.4-B switching back to A restores its own draft');
    await shot('sidebar-focus-a-draft', OUT4);
    /* 中央真的能发任务，且 Stop 只打当前这条会话。 */
    const ownerOf = async id => (await api()).items.find(i => i.owner?.conversationId === id)?.owner;
    const activityOf = async id => (await api()).items.find(i => i.owner?.conversationId === id)?.activity;
    await read(`(()=>{const t=document.querySelector('#runtimeView textarea');t.value='TASK_A2';t.dispatchEvent(new Event('input'));})()`);
    await read(`[...document.querySelectorAll('#runtimeView button')].find(b=>b.textContent==='发送').click()`);
    await until(async () => (await activityOf(idA)) === 'running', 30000);
    check(true, 'P32.4-B centre composer sends through the focused conversation');
    /* 同时让 B 也在跑 —— 否则「Stop A 不影响 B」证明不了什么。 */
    await api({ action: 'command', owner: await ownerOf(idB), command: { type: 'prompt', message: 'B_BUSY' } });
    await until(async () => (await activityOf(idB)) === 'running', 30000);
    check(!(await read(`[...document.querySelectorAll('#runtimeView button')].find(b=>b.textContent==='停止').disabled`)), 'P32.4-B centre Stop is enabled while the focused conversation is running');
    await read(`[...document.querySelectorAll('#runtimeView button')].find(b=>b.textContent==='停止').click()`);
    await until(async () => (await activityOf(idA)) === 'idle', 60000);
    check(true, 'P32.4-B centre Stop targeted the focused conversation (A)');
    check((await activityOf(idB)) === 'running', 'P32.4-B Stop on A leaves B running');
    /* A 有动作在飞时切到 B：B 的控件必须按 **B 自己**的状态可操作。
     * 用「重启 A」当那个长时间 pending 的动作（要重 spawn child），比 Stop 稳。 */
    await api({ action: 'command', owner: await ownerOf(idB), command: { type: 'prompt', message: 'B_AGAIN' } });
    await until(async () => (await activityOf(idB)) === 'running', 30000);
    await clickRow(idA);
    await until(async () => (await centerBranch()).includes('runtime-A'), 20000);
    await read(`[...document.querySelectorAll('#runtimeView button')].find(b=>b.textContent==='重启').click()`);
    await clickRow(idB);
    await until(async () => (await centerBranch()).includes('runtime-B'), 20000);
    check(!(await read(`[...document.querySelectorAll('#runtimeView button')].find(b=>b.textContent==='停止').disabled`)),
      'P32.4-B pending on A does not disable B controls after switching');
    check(await read(`document.querySelector('#runtimeView .rtc-notice').textContent === ''`), 'P32.4-B B shows no notice borrowed from A');
    await shot('sidebar-b-operable-while-a-pending', OUT4);

    /* ---- P32.4-C：真实 native Browser、owned Node 进程与 Git Changes ---- */
    await until(async () => (await api()).items.find(r => r.conversationId === idA)?.lifecycle === 'ready', 60000);
    const cOwners = [await ownerOf(idA), await ownerOf(idB)];
    const cScopes = cOwners.map(({ repoId, ...scope }) => scope);
    const recordFor = index => [...host.records.values()].find(r => r.scope.runtimeId === cScopes[index].runtimeId);
    const nativeIds = () => win.contentView.children.map(v => v.webContents?.id).filter(Boolean);
    const nativeOwnerIs = index => {
      const wanted = recordFor(index)?.controller.getWebContents();
      return wanted && nativeIds().includes(wanted.id)
        && ![...host.records.values()].some(r => r !== recordFor(index) && nativeIds().includes(r.controller.getWebContents()?.id));
    };
    const centerButton = label => read(`[...document.querySelectorAll('#runtimeView button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
    for (const [index, id] of [idA, idB].entries()) {
      await clickRow(id); await until(async () => (await centerBranch()).includes('runtime-' + ['A', 'B'][index]));
      await centerButton('Browser');
      await until(() => nativeOwnerIs(index));
      await read(`window.piGuiDesktop.runtimeBrowser.navigate(${JSON.stringify(cScopes[index])},${JSON.stringify(`http://127.0.0.1:${pages[index].address().port}`)})`);
      await until(() => recordFor(index).controller.getWebContents().getURL().startsWith(`http://127.0.0.1:${pages[index].address().port}`));
      const nativeContents = recordFor(index).controller.getWebContents();
      await until(() => nativeContents.executeJavaScript(`document.body?.textContent.includes('OWNER_${['A', 'B'][index]}')`));
      check(nativeOwnerIs(index), 'P32.4-C central Browser native view belongs to ' + ['A', 'B'][index]);
      const nativeFile = path.join(OUT4, 'c-browser-native-' + ['a', 'b'][index] + '.png');
      fs.writeFileSync(nativeFile, (await nativeContents.capturePage()).toPNG()); screenshots.push({ file: nativeFile, nativeBrowser: true, ownerLabel: ['A', 'B'][index] });
    }
    const browserA = recordFor(0).controller.getWebContents(), browserB = recordFor(1).controller.getWebContents();
    check(browserA !== browserB && !browserA.isDestroyed(), 'P32.4-C A Browser remains alive behind B');
    await shot('c-browser-b-native-owner', OUT4);
    await clickRow(idA); await until(() => nativeOwnerIs(0));
    await read(`import('/runtime-sessions.js').then(m=>m.openRuntimeSessions({path:${JSON.stringify(repo)}}))`);
    await until(() => read(`document.querySelectorAll('#modalCard .runtime-list .btn').length===2`));
    await read(`document.querySelector('#modalCard .runtime-list .btn').click()`); key('Escape');
    await until(async () => await read(`document.querySelector('#modal').hidden`) && nativeOwnerIs(0));
    check((await api()).focusedConversationId === idA, 'P32.4-C modal Escape retains central A focus and native Browser');
    await read(`import('/runtime-sessions.js').then(m=>m.openRuntimeSessions({path:${JSON.stringify(repo)}}))`);
    await until(() => read(`document.querySelectorAll('#modalCard .runtime-list .btn').length===2`));
    await click('#modalCard .wt-head button');
    await until(async () => await read(`document.querySelector('#modal').hidden`) && nativeOwnerIs(0));
    check((await api()).focusedConversationId === idA, 'P32.4-C ordinary modal close retains central A focus and native Browser');
    check(recordFor(0).controller.getWebContents() === browserA, 'P32.4-C returning to A preserves its original native Browser');
    await clickRow(idB); await until(() => nativeOwnerIs(1));
    await read(`document.querySelector('#runtimeView textarea').focus()`);
    const activeBeforeEvent = await read(`document.activeElement.getAttribute('aria-label')`);
    const masterA = recordFor(0).bridge.connection();
    const sessionA = await transport(masterA, '/session', { requestId: require('crypto').randomUUID() });
    const connA = { url: masterA.url, token: sessionA.token };
    const enabledA = await read(`window.piGuiDesktop.runtimeBrowser.enable(${JSON.stringify(cScopes[0])},true)`);
    assert.equal(enabledA.enabled, true, 'background A Browser permission must be admitted');
    const bgState = await transport(connA, '/state', { requestId: require('crypto').randomUUID() });
    const bgOpened = await transport(connA, '/action', { requestId: require('crypto').randomUUID(), action: 'open', args: { url: `http://127.0.0.1:${pages[0].address().port}/background` }, epoch: bgState.epoch, generation: bgState.generation });
    check(bgOpened.ok, 'P32.4-C background A Browser performs real CDP navigation' + (bgOpened.code ? ': ' + bgOpened.code : ''));
    await sleep(300);
    check(nativeOwnerIs(1) && (await api()).focusedConversationId === idB && await read(`document.querySelector('#rightPane').dataset.surface==='runtime-browser'`), 'P32.4-C A Browser event preserves B pane and native owner');
    check(await read(`document.activeElement.getAttribute('aria-label')`) === activeBeforeEvent, 'P32.4-C background Browser event does not steal keyboard focus');
    check(!(await read(`window.piGuiDesktop.runtimeBrowser.open(${JSON.stringify(scopes[0])})`)).ok, 'P32.4-C retired A Browser owner cannot remount');
    await click('#browserClose'); await until(() => !recordFor(1).controller.getWebContents());
    check(recordFor(0).controller.getWebContents() === browserA && !browserA.isDestroyed(), 'P32.4-C close Browser B preserves Browser A');

    const processAction = (index, args) => api({ action: 'process', owner: cOwners[index], args });
    const processStates = [], processRecords = [], serviceUrls = [];
    for (const index of [0, 1]) {
      const snapshot = await processAction(index, { action: 'status' });
      check(snapshot.ok && snapshot.available && !snapshot.enabled, 'P32.4-C owned Process permission starts disabled ' + index);
      await clickRow([idA, idB][index]); await until(async () => (await centerBranch()).includes('runtime-' + ['A', 'B'][index]));
      await centerButton('开发进程'); await until(() => read(`!!document.querySelector('.process-permission input:not([disabled])')`));
      await shot('c-process-permission-' + index, OUT4);
      await click('.process-permission input');
      check(await read(`document.querySelector('.process-permission input').checked`), 'P32.4-C real checkbox click enables requested Process permission ' + index);
      await until(async () => (await processAction(index, { action: 'status' })).enabled);
      const startedProcess = await api({ action: 'command', owner: cOwners[index], command: { type: 'prompt', message: 'FIXTURE_PROCESS_START ' + ['A', 'B'][index] } });
      check(startedProcess.ok, 'P32.4-C fixture Pi starts process through private owned bridge ' + index);
      await until(() => fs.existsSync(processDiagnostics) && fs.readFileSync(processDiagnostics, 'utf8').trim().split('\n').some(line => JSON.parse(line).label === ['A', 'B'][index]), 10000);
      const diagnostic = fs.readFileSync(processDiagnostics, 'utf8').trim().split('\n').map(JSON.parse).find(d => d.label === ['A', 'B'][index]);
      assert.equal(diagnostic.resultOk, true, 'private Process bridge result: ' + JSON.stringify(diagnostic));
      await until(async () => { processStates[index] = await processAction(index, { action: 'status' }); return processStates[index].processes[0]?.state === 'ready'; }, 30000);
      processRecords[index] = processStates[index].processes[0];
      const logs = await processAction(index, { action: 'logs', generation: processStates[index].generation, id: processRecords[index].id, revision: processRecords[index].revision, cursor: 0 });
      serviceUrls[index] = 'http://127.0.0.1:' + logs.lines.find(l => /^READY \d+/.test(l.text)).text.split(' ')[1];
      check(await (await fetch(serviceUrls[index])).text() === ['A', 'B'][index], 'P32.4-C real Node HTTP worker belongs to ' + ['A', 'B'][index]);
      await until(() => read(`document.querySelector('.process-logs')?.textContent.includes('PROCESS_${['A', 'B'][index]}')`));
    }
    check(processRecords[0].id !== processRecords[1].id, 'P32.4-C A/B production Process managers allocate independent records');
    for (const [index, id] of [idA, idB].entries()) {
      await clickRow(id); await until(() => read(`document.querySelector('.process-logs')?.textContent.includes('PROCESS_${['A', 'B'][index]}')`));
      check(await read(`!document.querySelector('.process-logs').textContent.includes('PROCESS_${['B', 'A'][index]}') && document.querySelector('.process-row').dataset.state==='ready'`), 'P32.4-C focused Process logs/status isolate ' + ['A', 'B'][index]);
      await shot('c-process-' + ['a', 'b'][index], OUT4);
    }
    await clickRow(idA); await until(() => read(`document.querySelector('.process-logs')?.textContent.includes('PROCESS_A')`));
    // Hold an actual A HTTP response at the renderer boundary. The real backend
    // still supplies its payload; only delivery is delayed to expose the race.
    await read(`(()=>{const original=window.fetch;window.__processOriginalFetch=original;window.__processHeld=false;window.fetch=async(...args)=>{const response=await original(...args);let body;try{body=JSON.parse(args[1]?.body||'null')}catch{}if(body?.action==='process'&&body.args?.action==='logs'&&body.owner?.conversationId===${JSON.stringify(idA)}&&!window.__processHeld){window.__processHeld=true;await new Promise(resolve=>window.__releaseProcess=resolve)}return response}})()`);
    await until(() => read(`window.__processHeld===true`), 5000);
    await clickRow(idB); await until(() => read(`document.querySelector('.process-logs')?.textContent.includes('PROCESS_B')`));
    await read(`window.__releaseProcess();window.fetch=window.__processOriginalFetch;delete window.__processOriginalFetch;delete window.__releaseProcess`); await sleep(300);
    check(await read(`document.querySelector('.process-logs').textContent.includes('PROCESS_B')&&!document.querySelector('.process-logs').textContent.includes('PROCESS_A')`), 'P32.4-C late real A Process HTTP response cannot overwrite B pane');
    const cross = await processAction(0, { action: 'stop', generation: processStates[0].generation, id: processRecords[1].id, revision: processRecords[1].revision });
    check(!cross.ok && cross.code === 'stale_process', 'P32.4-C cross-owner process id rejected');
    await clickRow(idA); await until(() => read(`document.querySelector('.process-logs')?.textContent.includes('PROCESS_A')`));
    await click('.process-actions button:first-child');
    await until(async () => (await processAction(0, { action: 'status' })).processes[0]?.state === 'exited', 30000);
    check(await (await fetch(serviceUrls[1])).text() === 'B', 'P32.4-C UI stop A leaves actual B worker responding');
    await until(() => read(`!document.querySelector('.process-actions button:last-child').disabled`));
    await click('.process-actions button:last-child');
    await until(async () => { const s = await processAction(0, { action: 'status' }); return s.processes[0]?.state === 'ready' && s.processes[0].revision !== processRecords[0].revision; }, 30000);
    check(await (await fetch(serviceUrls[1])).text() === 'B', 'P32.4-C UI restart A leaves actual B worker responding');
    const restartedState = await processAction(0, { action: 'status' }), restartedProcess = restartedState.processes[0];
    const restartedLogs = await processAction(0, { action: 'logs', generation: restartedState.generation, id: restartedProcess.id, revision: restartedProcess.revision, cursor: 0 });
    // Restart retains this owner's bounded log history. The newest READY line
    // identifies the replacement service; the previous port is intentionally dead.
    serviceUrls[0] = 'http://127.0.0.1:' + restartedLogs.lines.findLast(l => /^READY \d+/.test(l.text)).text.split(' ')[1];
    check(await (await fetch(serviceUrls[0])).text() === 'A', 'P32.4-C restarted A is an actual ready Node service');
    const staleProcess = await processAction(0, { action: 'stop', generation: processStates[0].generation, id: processRecords[0].id, revision: processRecords[0].revision });
    check(!staleProcess.ok && staleProcess.code === 'stale_process', 'P32.4-C old Process revision rejected after restart');

    const roots = workspaces.map(w => w.path);
    fs.writeFileSync(path.join(roots[0], 'a-only.txt'), 'A changed\n'); fs.writeFileSync(path.join(roots[1], 'b-only.txt'), 'B changed\n');
    await clickRow(idA); await until(async () => (await centerBranch()).includes('runtime-A'));
    await read(`import('/git.js').then(m=>{m.openChangesPanel();return m.refreshGitNow()})`);
    await until(() => read(`document.querySelector('.chg-path')?.textContent==='a-only.txt'`));
    await shot('c-changes-a', OUT4);
    const panePathsA = await read(`[...document.querySelectorAll('.chg-path')].map(n=>n.textContent)`);
    const gitStatusA = execFileSync('git', ['status', '--porcelain'], { cwd: roots[0], windowsHide: true, encoding: 'utf8' });
    check(panePathsA.join(',') === 'a-only.txt', 'P32.4-C focused A Changes contains only A modification; pane=' + JSON.stringify(panePathsA) + '; fixture Git=' + JSON.stringify(gitStatusA.trim().split('\n')));
    await clickRow(idB); await until(() => read(`document.querySelector('.chg-path')?.textContent==='b-only.txt'`));
    check(await read(`[...document.querySelectorAll('.chg-path')].map(n=>n.textContent).join(',')==='b-only.txt'`), 'P32.4-C focus switches Changes to B modification');
    await shot('c-changes-b', OUT4);
    await clickRow(idA); await until(() => read(`document.querySelector('.chg-path')?.textContent==='a-only.txt'`));
    await click('.chg-acts .danger'); await until(() => read(`!document.querySelector('#confirmLayer').hidden`));
    await read(`[...document.querySelectorAll('#confirmCard button')].find(b=>b.textContent==='撤销改动').click()`);
    await until(() => fs.readFileSync(path.join(roots[0], 'a-only.txt'), 'utf8') === 'base\n');
    check(fs.readFileSync(path.join(roots[1], 'b-only.txt'), 'utf8') === 'B changed\n' && fs.readFileSync(path.join(repo, 'a-only.txt'), 'utf8') === 'base\n', 'P32.4-C UI restore A leaves B worktree and classic cwd untouched');
    await shot('c-changes-a-restored', OUT4);

    /* 回到经典会话时中央必须换回 chat，否则看起来像「点了没反应」。 */
    await read(`import('/ui/workspace-surface.js').then(m=>m.showChat())`);
    check(await read(`document.querySelector('#workspace').dataset.workspaceView === 'chat' && !document.querySelector('#runtimeView').offsetParent`), 'P32.4-B leaving the parallel conversation restores the classic chat centre');
    /* 用**当前** owner 关闭 A/B：P32.4-B 段重启过 A，identity 已经换代，
     * 拿旧的 resumed/owners[1] 去关只会得到 stale_runtime。关的还是同两条会话。
     * 先等 A 的重启落定（ready），否则 close 会和 restart 撞在一起。 */
    await until(async () => { const s = await api(); const a = s.items.find(i => i.owner?.conversationId === owners[0].conversationId); return a?.lifecycle === 'ready'; }, 60000).catch(() => {});
    state = await api();
    const currentOwnerOf = id => state.items.find(i => i.owner?.conversationId === id)?.owner;
    await api({ action: 'close', owner: currentOwnerOf(owners[0].conversationId) });
    await api({ action: 'close', owner: currentOwnerOf(owners[1].conversationId) });
    state = await api();
    check(state.liveCount === 0 && state.items.length === 2, `close cleanup retains lazy records (live=${state.liveCount}, items=${state.items.length})`);
    await until(async () => (await Promise.all(serviceUrls.map(async url => { try { await fetch(url); return false; } catch { return true; } }))).every(Boolean), 30000);
    check(true, 'P32.4-C closing runtimes actually closes both owned Node HTTP workers');
    check(host.records.size === 0 && browserA.isDestroyed(), 'P32.4-C runtime close disposes owned Browser records and native views');
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

    /* ---- P32.4-D: totalCount includes the classic child; UI launch paths use
     * backend snapshots and ask before explicit third admission. ---- */
    await read(`import('/sessions.js').then(m=>m.refreshSidebarSessions())`);
    await until(() => read(`document.querySelectorAll('#pjRuntimeList [data-conversation-id]').length===2`));
    await clickRow(idA); await until(async () => (await centerBranch()).includes('runtime-A'));
    const quotaText = () => read(`document.querySelector('#runtimeView .runtime-resource-count')?.textContent || ''`);
    await until(async () => (await quotaText()) === '正在运行 2 / 2');
    state = await api();
    check(state.totalCount === 2 && state.liveCount === 1 && state.limit === 2 && state.hardLimit === 3, 'P32.4-D classic plus A fills two regular slots with backend limits unchanged');
    check(await read(`document.querySelector('#pjRuntimeList .runtime-resource-count').textContent==='正在运行 2 / 2'`), 'P32.4-D sidebar resource count comes from totalCount including classic');
    await shot('d-two-regular-slots', OUT4);
    await read(`(()=>{const original=window.fetch;window.__resourceOriginalFetch=original;window.__resourceRequests=[];window.__resourceFocusRequests=[];window.fetch=async(...args)=>{let body;try{body=JSON.parse(args[1]?.body||'null')}catch{}const runtime=String(args[0]).includes('/api/runtime-sessions'),launch=runtime&&['start','resume'].includes(body?.action);const entry=launch?{action:body.action,conversationId:body.conversationId||null,workspaceId:body.args?.id||null,allowThird:body.action==='start'?body.args?.allowThird===true:body.allowThird===true}:runtime&&body?.action==='focus'?{action:'focus',conversationId:body.owner?.conversationId,runtimeId:body.owner?.runtimeId,runtimeGeneration:body.owner?.runtimeGeneration}:null;if(entry)(launch?window.__resourceRequests:window.__resourceFocusRequests).push(entry);const response=await original(...args);if(entry){const result=await response.clone().json();entry.ok=result.ok;entry.code=result.code||null;if(body.action==='resume')entry.returnedOwner={conversationId:result.owner?.conversationId,runtimeId:result.owner?.runtimeId,runtimeGeneration:result.owner?.runtimeGeneration};}return response}})()`);
    await clickRow(idB); await until(async () => (await centerBranch()).includes('runtime-B'));
    await centerButton('打开历史'); await until(() => read(`document.querySelector('#runtimeView .rtc-state').textContent.includes('只读历史')`));
    state = await api();
    check(state.totalCount === 2 && !state.items.find(r => r.conversationId === idB).owner, 'P32.4-D dormant B history opens at full regular capacity without spawning');
    check(await read(`window.__resourceRequests.length===0`), 'P32.4-D opening history never sends a launch request');
    await centerButton('恢复会话'); await until(() => read(`!document.querySelector('#confirmLayer').hidden`));
    check(await read(`document.querySelector('#confirmCard').textContent.includes('第三个')&&document.querySelector('#confirmCard').textContent.includes('CPU、内存和模型请求')`), 'P32.4-D third Resume explains resource cost before launch');
    check(await read(`window.__resourceRequests.length===0`) && (await api()).totalCount === 2, 'P32.4-D third confirmation appears before any Pi spawn request');
    await shot('d-third-confirmation', OUT4);
    await read(`[...document.querySelectorAll('#confirmCard button')].find(b=>b.textContent==='取消').click()`);
    await until(() => read(`document.querySelector('#confirmLayer').hidden&&![...document.querySelectorAll('#runtimeView button')].find(b=>b.textContent==='恢复会话').disabled`));
    state = await api();
    check(state.totalCount === 2 && state.items.find(r => r.conversationId === idB).lifecycle === 'dormant' && await read(`window.__resourceRequests.length===0`), 'P32.4-D Cancel leaves B dormant and sends no resume');
    await centerButton('恢复会话'); await until(() => read(`!document.querySelector('#confirmLayer').hidden`));
    await read(`[...document.querySelectorAll('#confirmCard button')].find(b=>b.textContent==='继续启动').click()`);
    await until(async () => { state = await api(); return state.totalCount === 3 && state.items.find(r => r.conversationId === idB)?.lifecycle === 'ready'; }, 60000);
    check(await read(`window.__resourceRequests.length===1&&window.__resourceRequests[0].action==='resume'&&window.__resourceRequests[0].conversationId===${JSON.stringify(idB)}&&window.__resourceRequests[0].allowThird===true&&window.__resourceRequests[0].ok===true`), 'P32.4-D confirmed central Resume sends top-level allowThird true exactly once');
    await until(async () => (await quotaText()) === '3 个会话正在运行');
    console.log('D after third safe focus evidence: ' + JSON.stringify({ backendFocusedB: (await api()).focusedConversationId === idB, renderer: await read(`import('/runtime-state.js').then(m=>{const r=m.runtimeStore.get(${JSON.stringify(idB)});return{requests:window.__resourceRequests,focusRequests:window.__resourceFocusRequests,title:document.querySelector('#runtimeView .rtc-title')?.textContent,view:document.querySelector('#workspace').dataset.workspaceView,b:{lifecycle:r?.item.lifecycle,conversationId:r?.owner?.conversationId,runtimeId:r?.owner?.runtimeId,runtimeGeneration:r?.owner?.runtimeGeneration}}})`) }));
    check(state.liveCount === 2 && state.items.find(r => r.conversationId === idA).owner.runtimeId === recovered.runtimeId, 'P32.4-D third child ready preserves existing A runtime');
    await shot('d-third-active', OUT4);
    const thirdOwner = state.items.find(r => r.conversationId === idB).owner;

    await read(`document.querySelector('#pjRuntimeList .pj-runtime-new').click()`);
    await until(() => read(`!!document.querySelector('#modalCard input')&&!document.querySelector('#modal').hidden`));
    await read(`(()=>{const i=document.querySelector('#modalCard input');i.value='p32-4-fourth-rejected';i.dispatchEvent(new Event('input'))})()`);
    await read(`[...document.querySelectorAll('#modalCard button')].find(b=>b.textContent==='创建并启动').click()`);
    await until(() => read(`window.__resourceRequests.some(r=>r.action==='start'&&r.code==='runtime_limit')`), 60000);
    check(await read(`window.__resourceRequests.filter(r=>r.action==='start').length===1&&!window.__resourceRequests.find(r=>r.action==='start').allowThird`), 'P32.4-D fourth sidebar create actually reaches backend and receives runtime_limit');
    await until(() => read(`[...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('运行名额已满')&&t.textContent.includes('打开历史'))`));
    check(await read(`document.querySelector('#confirmLayer').hidden`), 'P32.4-D fourth request shows backend rejection without another third confirmation');
    state = await api();
    check(state.totalCount === 3 && state.items.find(r => r.conversationId === idA).owner.runtimeId === recovered.runtimeId && state.items.find(r => r.conversationId === idB).owner.runtimeId === thirdOwner.runtimeId, 'P32.4-D fourth rejection never replaces or closes existing A/B');
    await shot('d-fourth-rejected', OUT4);

    // Populate real B Browser and Process resources, then close via central UI.
    // A retained slot must not be freed before their owned cleanup completes.
    await until(async () => (await api()).focusedConversationId === idB);
    check((await api()).focusedConversationId === idB, 'P32.4-D resumed current central B receives backend focus after ready');
    await centerButton('Browser');
    let thirdRecord;
    await until(() => { thirdRecord = [...host.records.values()].find(r => r.scope.runtimeId === thirdOwner.runtimeId);
      return thirdRecord?.controller.getWebContents() && win.contentView.children.some(v => v.webContents === thirdRecord.controller.getWebContents()); });
    const thirdBrowser = thirdRecord.controller.getWebContents();
    await centerButton('开发进程');
    await until(() => read(`!!document.querySelector('.process-permission input:not([disabled])')`));
    await click('.process-permission input');
    const thirdProcess = args => api({ action: 'process', owner: thirdOwner, args });
    await until(async () => (await thirdProcess({ action: 'status' })).enabled);
    await api({ action: 'command', owner: thirdOwner, command: { type: 'prompt', message: 'FIXTURE_PROCESS_START D_B' } });
    let thirdProcessState;
    await until(async () => { thirdProcessState = await thirdProcess({ action: 'status' }); return thirdProcessState.processes[0]?.state === 'ready'; }, 30000);
    const thirdWorker = thirdProcessState.processes[0], thirdLogs = await thirdProcess({ action: 'logs', generation: thirdProcessState.generation, id: thirdWorker.id, revision: thirdWorker.revision, cursor: 0 });
    const thirdUrl = 'http://127.0.0.1:' + thirdLogs.lines.findLast(l => /^READY \d+/.test(l.text)).text.split(' ')[1];
    check(await (await fetch(thirdUrl)).text() === 'D_B', 'P32.4-D third conversation owns real Browser and ready Node service before close');
    await read(`import('/runtime-state.js').then(m=>{window.__dClosedCounts=[];window.__dOff=m.onRuntimeChange(()=>{if(m.runtimeStore.get(${JSON.stringify(idB)})?.item.lifecycle==='dormant')window.__dClosedCounts.push(m.runtimeStore.resources().totalCount)})})`);
    await centerButton('关闭会话');
    await until(async () => { state = await api(); return state.totalCount === 2 && state.items.find(r => r.conversationId === idB)?.lifecycle === 'dormant'; }, 30000);
    check(await read(`window.__dClosedCounts.length>0&&window.__dClosedCounts[0]===3`), 'P32.4-D closed SSE does not optimistically release the authoritative slot count');
    check(thirdBrowser.isDestroyed() && ![...host.records.values()].some(r => r.scope.runtimeId === thirdOwner.runtimeId), 'P32.4-D close frees third Browser owner before slot readback drops');
    await until(async () => { try { await fetch(thirdUrl); return false; } catch { return true; } });
    check(true, 'P32.4-D close actually stops third owned Node service before released-slot readback');
    await until(async () => (await quotaText()) === '正在运行 2 / 2');
    check(state.items.find(r => r.conversationId === idA).owner.runtimeId === recovered.runtimeId, 'P32.4-D closing B recovers its slot and preserves A');
    await centerButton('打开历史'); await until(() => read(`document.querySelector('#runtimeView .rtc-state').textContent.includes('只读历史')`));
    check((await api()).totalCount === 2 && await read(`window.__resourceRequests.length===2`), 'P32.4-D closed B history remains accessible without another launch');
    await shot('d-close-slot-recovered-history', OUT4);
    await read(`window.__dOff();window.fetch=window.__resourceOriginalFetch;delete window.__resourceOriginalFetch;delete window.__dOff`);

    /* P32.4-E: native model confirmation, exact history identity and physical
     * keyboard/layout checks share the same real fixture-owned conversations. */
    await centerButton('恢复会话'); await until(() => read(`!document.querySelector('#confirmLayer').hidden`));
    await read(`[...document.querySelectorAll('#confirmCard button')].find(b=>b.textContent==='继续启动').click()`);
    await until(async () => { state = await api(); return state.items.find(r => r.conversationId === idB)?.owner?.sessionId && state.focusedConversationId === idB; });
    const eOwnerB = state.items.find(r => r.conversationId === idB).owner;
    const modelSel = '#runtimeView select[aria-label="当前会话模型"]', thinkingSel = '#runtimeView select[aria-label="当前会话推理强度"]';
    const modelValue = () => read(`document.querySelector(${JSON.stringify(modelSel)}).value`);
    const modelId = async () => JSON.parse((await modelValue()) || '{}').modelId;
    const chooseModel = value => read(`(()=>{const s=document.querySelector(${JSON.stringify(modelSel)});s.value=JSON.stringify({providerId:'fixture',modelId:${JSON.stringify(value)}});s.dispatchEvent(new Event('change'))})()`);
    await until(async () => (await modelId()) === 'text-b' && await read(`!document.querySelector(${JSON.stringify(modelSel)}).disabled`));
    check(await read(`document.querySelector(${JSON.stringify(thinkingSel)}).disabled&&document.querySelector('.rtc-model-notice').textContent.includes('不支持推理')`), 'P32.4-E B false capability disables native thinking choices');
    await shot('e-model-b-text', OUT4);
    await clickRow(idA); await until(async () => (await modelId()) === 'reason-a');
    check(await read(`!document.querySelector(${JSON.stringify(thinkingSel)}).disabled&&[...document.querySelector(${JSON.stringify(thinkingSel)}).options].map(o=>o.value).join(',')===',off,low,high'`), 'P32.4-E A thinking choices come from native Pi levels');
    await shot('e-model-a-reasoning', OUT4);
    await chooseModel('delayed');
    check((await modelId()) === 'reason-a' && await read(`document.querySelector(${JSON.stringify(modelSel)}).disabled`), 'P32.4-E HTTP setter ack cannot optimistically replace A model');
    await clickRow(idB); await until(async () => (await modelId()) === 'text-b');
    await sleep(1500);
    check((await modelId()) === 'text-b', 'P32.4-E late correlated A model response/readback never overwrites B selector');
    await clickRow(idA); await until(async () => (await modelId()) === 'delayed' && await read(`!document.querySelector(${JSON.stringify(modelSel)}).disabled`));
    check(true, 'P32.4-E A selector changes only after successful native response and readback');
    await chooseModel('reject'); await clickRow(idB); await sleep(900);
    check((await modelId()) === 'text-b', 'P32.4-E late failed A model request never changes B');
    await clickRow(idA); await until(() => read(`document.querySelector('.rtc-model-notice').textContent.includes('未能确认')`));
    check((await modelId()) === 'delayed', 'P32.4-E native setter rejection preserves last confirmed A model');
    await chooseModel('unknown'); await until(async () => (await modelId()) === 'unknown');
    check(await read(`document.querySelector(${JSON.stringify(thinkingSel)}).disabled&&document.querySelector('.rtc-model-notice').textContent.includes('未知')`), 'P32.4-E unknown reasoning capability stays unknown without guessed levels');
    await chooseModel('reason-a'); await until(async () => (await modelId()) === 'reason-a' && await read(`!document.querySelector(${JSON.stringify(thinkingSel)}).disabled`));
    await read(`(()=>{const s=document.querySelector(${JSON.stringify(thinkingSel)});s.value='high';s.dispatchEvent(new Event('change'))})()`);
    await until(() => read(`!document.querySelector(${JSON.stringify(thinkingSel)}).disabled&&document.querySelector(${JSON.stringify(thinkingSel)}).value==='high'`));
    check(true, 'P32.4-E A thinking setter confirmed by native readback');
    await read(`document.querySelector(${JSON.stringify(thinkingSel)}).focus()`); key('Up');
    await until(() => read(`!document.querySelector(${JSON.stringify(thinkingSel)}).disabled&&document.querySelector(${JSON.stringify(thinkingSel)}).value==='low'`));
    check(true, 'P32.4-E physical Arrow navigation selects a native allowed thinking level');
    await clickRow(idB); await until(async () => (await modelId()) === 'text-b');
    check(await read(`document.querySelector(${JSON.stringify(thinkingSel)}).disabled`), 'P32.4-E A thinking change leaves B unsupported capability intact');

    await clickRow(idA); await until(async () => (await modelId()) === 'reason-a');
    const composerSel = '#runtimeView textarea[aria-label="给当前会话的任务"]';
    await click(composerSel);
    await read(`(()=>{const i=document.querySelector(${JSON.stringify(composerSel)});i.value='E_NATIVE_A_UNIQUE';i.dispatchEvent(new Event('input'))})()`);
    key('Enter'); await until(() => read(`document.querySelector('.rtc-output').textContent.includes('E_NATIVE_A_UNIQUE')`));
    check(await read(`document.querySelector(${JSON.stringify(composerSel)}).value===''`), 'P32.4-E physical Enter sends only captured A and clears confirmed draft');
    await api({ action: 'command', owner: recovered, command: { type: 'abort' } });
    await api({ action: 'command', owner: eOwnerB, command: { type: 'prompt', message: 'E_NATIVE_B_UNIQUE' } });
    await api({ action: 'command', owner: eOwnerB, command: { type: 'abort' } });
    await click(composerSel); key('Tab'); await sleep(100);
    check(await read(`document.activeElement!==document.querySelector(${JSON.stringify(composerSel)})`), 'P32.4-E physical Tab leaves central composer through normal focus order');
    key('Tab', ['shift']); await sleep(100);
    check(await read(`document.activeElement===document.querySelector(${JSON.stringify(composerSel)})`), 'P32.4-E physical Shift+Tab restores central composer focus');
    await read(`(()=>{const b=document.querySelector('#pjRuntimeList .pj-runtime-new');b.focus();b.click()})()`);
    await until(() => read(`!document.querySelector('#modal').hidden`));
    key('Tab'); await sleep(100); check(await read(`document.querySelector('#modalCard').contains(document.activeElement)`), 'P32.4-E branch modal traps physical Tab');
    key('Escape'); await until(() => read(`document.querySelector('#modal').hidden`));
    check(await read(`document.activeElement===document.querySelector('#pjRuntimeList .pj-runtime-new')`), 'P32.4-E Escape closes modal and restores exact trigger focus');

    await centerButton('开发进程');
    for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080]]) {
      win.setContentSize(w, h); await until(() => read(`innerWidth===${w}&&innerHeight===${h}`));
      check(await read(`(()=>{const c=document.querySelector(${JSON.stringify(composerSel)}).getBoundingClientRect(),p=document.querySelector('#rightPane').getBoundingClientRect();return c.width>100&&c.bottom<=innerHeight+1&&c.right<=p.left+1})()`), `P32.4-E central composer stays usable beside right pane ${w}x${h}`);
      await shot(`e-central-${w}x${h}`, OUT4);
    }
    win.setContentSize(1440, 900);
    for (const zoom of [1.25, 1.5]) {
      win.webContents.setZoomFactor(zoom); await until(() => read(`Math.abs(innerWidth-${1440 / zoom})<2`));
      check(await read(`(()=>{const c=document.querySelector(${JSON.stringify(composerSel)}).getBoundingClientRect(),m=document.querySelector(${JSON.stringify(modelSel)}).getBoundingClientRect(),p=document.querySelector('#rightPane').getBoundingClientRect();return c.width>100&&c.right<=p.left+1&&m.right<=p.left+1})()`), `P32.4-E zoom ${zoom * 100} central composer and model selector are not covered by right pane`);
      await shot(`e-central-zoom${zoom * 100}`, OUT4);
    }
    win.webContents.setZoomFactor(1); await until(() => read(`innerWidth===1440`));
    await centerButton('Browser');
    let eBrowserRecord;
    await until(() => { eBrowserRecord = [...host.records.values()].find(r => r.scope.runtimeId === recovered.runtimeId);
      return eBrowserRecord && win.contentView.children.some(v => v.webContents === eBrowserRecord.controller.getWebContents()); });
    const { repoId: eRepoId, ...eBrowserScope } = recovered;
    await read(`window.piGuiDesktop.runtimeBrowser.navigate(${JSON.stringify(eBrowserScope)},${JSON.stringify(`http://127.0.0.1:${pages[0].address().port}`)})`);
    await until(() => eBrowserRecord.controller.getWebContents().executeJavaScript(`document.body?.textContent.includes('OWNER_A')`));
    win.webContents.setZoomFactor(1.5); await until(() => read(`Math.abs(innerWidth-960)<2`)); await sleep(250);
    const eNativeView = win.contentView.children.find(v => v.webContents === eBrowserRecord.controller.getWebContents()), eNativeBounds = eNativeView.getBounds(), eWindowSize = win.getContentSize();
    check(eNativeBounds.width > 0 && eNativeBounds.height > 0 && eNativeBounds.x >= 0 && eNativeBounds.y >= 0 && eNativeBounds.x + eNativeBounds.width <= eWindowSize[0] && eNativeBounds.y + eNativeBounds.height <= eWindowSize[1], 'P32.4-E actual native Browser bounds stay inside the window at 150 percent zoom');
    await shot('e-browser-zoom150', OUT4);
    const eNativeFile = path.join(OUT4, 'e-browser-native-zoom150.png'); fs.writeFileSync(eNativeFile, (await eNativeView.webContents.capturePage()).toPNG()); screenshots.push({ file: eNativeFile, nativeBrowser: true, ownerLabel: 'A', bounds: eNativeBounds });
    win.webContents.setZoomFactor(1); await until(() => read(`innerWidth===1440`));

    const search = await api(null, '/api/sessions/search?q=E_NATIVE_&scope=all');
    const aHit = search.results.find(r => r.locator?.conversationId === idA), bHit = search.results.find(r => r.locator?.conversationId === idB);
    check(aHit?.locator.nativeSessionId === recovered.sessionId && bHit?.locator.nativeSessionId === eOwnerB.sessionId && aHit.locator.workspaceId !== bHit.locator.workspaceId, 'P32.4-E real native body search preserves project/worktree/conversation/native identity');
    await click('#navSearch'); await read(`(()=>{const i=document.querySelector('.pj-search-input');i.value='E_NATIVE_';i.dispatchEvent(new Event('input'))})()`);
    await until(() => read(`document.querySelectorAll('.pj-sr[data-conversation-id]').length===2`));
    await click(`.pj-sr[data-conversation-id="${idA}"] .pj-sr-hit`);
    await until(() => read(`document.querySelector('.rtc-state').textContent.includes('只读历史')&&document.querySelector('.rtc-output').textContent.includes('E_NATIVE_A_UNIQUE')`));
    check(!await read(`document.querySelector('.rtc-output').textContent.includes('E_NATIVE_B_UNIQUE')`), 'P32.4-E live search opens exact A native history without cross-owner body');
    await shot('e-search-live-history-a', OUT4);
    await api({ action: 'close', owner: eOwnerB });
    await read(`import('/sessions.js').then(m=>m.refreshSidebarSessions())`);
    await click('#navSearch'); await read(`(()=>{const i=document.querySelector('.pj-search-input');i.value='E_NATIVE_B_UNIQUE';i.dispatchEvent(new Event('input'))})()`);
    await until(() => read(`Boolean(document.querySelector('.pj-sr[data-conversation-id="${idB}"] .pj-sr-hit'))`));
    await click(`.pj-sr[data-conversation-id="${idB}"] .pj-sr-hit`);
    await until(() => read(`document.querySelector('.rtc-state').textContent.includes('只读历史')&&document.querySelector('.rtc-output').textContent.includes('E_NATIVE_B_UNIQUE')`));
    check((await api()).totalCount === 2 && !await read(`document.querySelector('.rtc-output').textContent.includes('E_NATIVE_A_UNIQUE')`), 'P32.4-E dormant native body result opens B history without spawn or A contamination');
    await shot('e-search-dormant-history-b', OUT4);
    await click('.pj-search-input'); key('Escape'); await until(() => read(`document.querySelector('.pj-search-input').value===''`));
    check(true, 'P32.4-E physical Escape clears integrated search back to normal history navigation');
    await click('#navHome'); await until(() => read(`document.querySelector('#workspace').dataset.workspaceView==='chat'`));
    await click('#input'); await read(`(()=>{const i=document.querySelector('#input');i.value='E_CLASSIC_BODY_UNIQUE';i.dispatchEvent(new Event('input'))})()`); key('Enter');
    await until(async () => { const r = await api(null, '/api/sessions/search?q=E_CLASSIC_BODY_UNIQUE&scope=all'); return r.results?.some(item => !item.locator); });
    check(await read(`!document.querySelector('#chatComposer').hidden&&document.querySelector('#runtimeView').hidden`), 'P32.4-E classic physical Enter and native body search retain ordinary session identity');
    await api({ type: 'abort' }, '/api/command');
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
    const report = JSON.stringify({ checks, platform: process.platform, electron: process.versions.electron, screenshots, errors }, null, 2);
    fs.writeFileSync(path.join(OUT, 'report.json'), report); fs.writeFileSync(path.join(OUT4, 'electron-report.json'), report);
    console.log(`Runtime Electron ${checks}/${checks}; ${screenshots.length} screenshots`);
  }
  async function finish(code) { try { backend?.kill(); await host?.stop(); await legacyHost?.stop(); browser?.destroy(); for (const page of pages) { page.closeAllConnections(); page.close(); } win?.destroy(); } catch {} setTimeout(() => app.exit(code), 500); }
  /* 失败时把渲染进程 console 错误与 modal 状态一起打出来 —— 否则
   * 「Script failed to execute」这类错误只能看到 Electron 的包装信息，定位不到根因。 */
  main().then(() => finish(0), async error => { console.error(error); console.error('renderer console errors: ' + JSON.stringify(errors)); try { console.error('state: ' + JSON.stringify(await read(`({open: !document.querySelector('#modal').hidden, listBtns: document.querySelectorAll('#modalCard .runtime-list .btn').length, out: (document.querySelector('#modalCard .runtime-output')||{}).textContent, view: document.querySelector('#workspace').dataset.workspaceView, navRows: document.querySelectorAll('#pjRuntimeList [data-conversation-id]').length, appBooted: Boolean(document.querySelector('#pjSessionsBox')),processUi:{checked:document.querySelector('.process-permission input')?.checked,disabled:document.querySelector('.process-permission input')?.disabled,message:document.querySelector('.process-message')?.textContent},surface:document.querySelector('#rightPane')?.dataset.surface})`))); console.error('attached scoped native views: ' + [...host.records.values()].filter(r => win.contentView.children.some(v => v.webContents === r.controller.getWebContents())).length); } catch (e) { console.error('state unreadable: ' + e.message); } await finish(1); });
}
