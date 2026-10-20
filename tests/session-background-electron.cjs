/* Real production ES modules/CSS and native input; all data is offline fixture data. */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-background-window-'));
  const env = { ...process.env, BACKGROUND_WORLD: world }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, '--no-sandbox'], { env, stdio: 'inherit', windowsHide: true });
  child.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
} else run().catch(error => { console.error(error); require('electron').app.exit(1); });

async function run() {
  const { app, BrowserWindow } = require('electron');
  const world = process.env.BACKGROUND_WORLD, out = process.env.BACKGROUND_OUT || path.join(world, 'evidence');
  app.setPath('userData', path.join(world, 'profile')); app.on('window-all-closed', () => {});
  let win, harness; const checks = [], errors = [], shots = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const read = source => win.webContents.executeJavaScript(source, true);
  function check(pass, name, detail) { checks.push({ pass: !!pass, name, detail }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (pass ? '' : ' ' + JSON.stringify(detail))); }
  async function waitFor(test) { for (let i = 0; i < 80; i++) { if (await read(test)) return; await sleep(50); } throw Error('condition timed out: ' + test); }
  async function shot(name) { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); shots.push(file); }
  async function click(selector) {
    const point = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 }); await sleep(100);
  }
  async function keyEnter() {
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await sleep(100);
  }
  const timeout = setTimeout(() => { console.error('background window timeout'); app.exit(1); }, 180000);
  try {
    fs.mkdirSync(out, { recursive: true }); await app.whenReady();
    harness = spawn(process.execPath, [path.join(ROOT, 'tests/visual-harness.cjs')], {
      cwd: world, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0', VISUAL_PUBLIC_ROOT: process.env.VISUAL_ASSETS_ROOT || path.join(ROOT, 'public'), VISUAL_UPLOAD_DIR: path.join(world, 'uploads') },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    harness.stderr.on('data', data => errors.push(String(data)));
    const origin = await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(Error('harness timeout')), 15000);
      harness.stdout.on('data', data => { output += data; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
      harness.on('error', reject);
    });
    win = new BrowserWindow({ width: 1280, height: 950, show: true, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    await win.loadURL(origin); await sleep(1500); win.focus(); win.webContents.focus(); win.webContents.debugger.attach('1.3');
    await read(`(async()=>{
      window.ST=await import('/state.js');window.M=await import('/messages.js');window.P=await import('/projects.js');window.SESS=await import('/sessions.js');
      window.AP=await import('/approval.js');window.WS=await import('/ui/workspace-surface.js');window.RS=await import('/runtime-state.js');window.NAV=await import('/runtime-nav.js');
      window.commands=[];window.runtimeActions=[];window.otherWrites=[];window.snapshot={ok:true,backendInstance:'fixture-backend',liveCount:0,totalCount:1,limit:2,hardLimit:3,items:[]};
      window.fixtureCwd='C:/fixture/project-A';window.fixtureOther='C:/fixture/project-B';
      Object.assign(ST.S,{cwd:fixtureCwd,hasProject:true,bridgeState:'ready',switching:false,submitting:false,stopping:false,fallbackActive:false,modelSwitchPending:false,state:{sessionId:'native-A',model:{id:'fixture'}}});
      ST.el.input.disabled=false;ST.el.composerBox.classList.remove('is-locked');
      const original=window.fetch.bind(window);window.fetch=async(url,opt={})=>{
        const u=new URL(String(url),location.href),body=opt.body?JSON.parse(opt.body):null;let value;
        if(u.pathname==='/api/projects'&&!body)value={ok:true,active:fixtureCwd,items:[{path:fixtureCwd,name:'Fixture Project A'},{path:fixtureOther,name:'Fixture Project B'}]};
        else if(u.pathname==='/api/sessions')value={ok:true,hasProject:true,sessions:[{id:'aaaaaaaaaaaaaaaa',sessionId:'native-A',title:'A background task',current:true,updatedAt:Date.now()},{id:'bbbbbbbbbbbbbbbb',sessionId:'native-B',title:'B saved conversation',current:false,updatedAt:Date.now()}]};
        else if(u.pathname==='/api/sessions/history')value={ok:true,messages:[{role:'assistant',text:'B persisted result',userIndex:0}]};
        else if(u.pathname==='/api/worktrees')value={ok:true,projectId:'project',items:[]};
        else if(u.pathname==='/api/runtime-sessions'&&!body)value=snapshot;
        else if(u.pathname==='/api/runtime-sessions'){runtimeActions.push(body);value={ok:true,owner:body.owner,data:{models:[],messages:[]}};}
        else if(u.pathname==='/api/command'){commands.push(body);value={ok:true};}
        else if(opt.method&&opt.method!=='GET'&&u.pathname!=='/api/logs/events'){otherWrites.push(u.pathname);return original(url,opt);}
        else return original(url,opt);
        return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
      };
      await P.loadProjects();await SESS.refreshSidebarSessions();
      M.rebuildFromMessages([{role:'user',content:'A long task'}]);M.setStreaming(true);
      M.onMessageStart({message:{role:'assistant',content:[]}});M.onMessageUpdate({assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'A unfinished output'}});
      window.originalThread=ST.S.thread;
    })()`);
    await waitFor(`!!document.querySelector('button[aria-label="切换会话：B saved conversation"]')`);
    const other = 'button[aria-label="切换会话：B saved conversation"]', primary = 'button[aria-label="切换会话：A background task"]';
    await click(other); await waitFor(`document.querySelector('#workSurface').textContent.includes('B persisted result')`);
    check(await read(`WS.workspaceView()==='history'&&ST.S.streaming&&ST.S.thread===originalThread&&ST.S.thread.textContent.includes('A unfinished output')&&commands.length===0`), 'A -> B mouse switch keeps original stream and sends no switch/abort');
    await read(`M.onMessageUpdate({assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:' continuing in background'}})`);
    await read(`document.querySelector(${JSON.stringify(primary)}).focus()`); await keyEnter();
    check(await read(`WS.workspaceView()==='chat'&&ST.S.thread===originalThread&&ST.S.thread.textContent.includes('continuing in background')`), 'keyboard returns to A with live output retained');
    for (let i=0;i<6;i++) { await click(other); await click(primary); }
    check(await read(`WS.workspaceView()==='chat'&&ST.S.thread===originalThread&&ST.S.streaming&&ST.S.state.sessionId==='native-A'&&commands.length===0`), 'six rapid A/B round trips preserve task identity and mounted messages');
    await click('#navNew');
    check(await read(`WS.workspaceView()==='history'&&!!document.querySelector('#workSurface textarea')&&!commands.some(c=>c.type==='new_session')&&ST.S.streaming`), 'new-session action opens an isolated draft without interrupting A');
    await click(primary);
    await read(`AP.observeApprovalEvent({type:'extension_ui_request',id:'classic-approval-A',method:'confirm',title:'A fixture approval',message:'Only A may decide'},ST.S)`);
    await waitFor(`!![...document.querySelectorAll('#confirmCard button')].find(b=>b.textContent==='稍后处理')`);
    await read(`document.querySelectorAll('#confirmCard button').forEach(b=>{if(b.textContent==='稍后处理')b.id='deferA'})`); await click('#deferA');
    await click(other);
    check(await read(`AP.approvalSnapshot().pending.length===1&&!commands.some(c=>c.type==='extension_ui_response')&&!document.querySelector('#btnPendingClassicApproval').hidden`), 'A approval is deferred while B is viewed, without cancellation or auto-approval');
    for (const theme of ['light','dark']) { await read(`document.documentElement.dataset.theme='${theme}'`); await sleep(180); await shot(theme + '-background-history'); }
    await click('#btnPendingClassicApproval'); await waitFor(`document.querySelector('#confirmCard').textContent.includes('A fixture approval')`);
    await read(`document.querySelectorAll('#confirmCard button').forEach(b=>{if(b.textContent==='允许一次')b.id='allowA'})`); await click('#allowA');
    check(await read(`commands.filter(c=>c.type==='extension_ui_response').length===1&&commands.find(c=>c.type==='extension_ui_response').id==='classic-approval-A'&&WS.workspaceView()==='chat'`), 'resumed approval sends exactly one response to A request');
    await click(other); await click('#workSurface textarea');
    await read(`M.onSettled()`);
    check(await read(`document.activeElement===document.querySelector('#workSurface textarea')&&WS.workspaceView()==='history'`), 'background completion does not steal focus from B draft');
    await read(`(async()=>{
      window.owners={};window.seq={RA:0,RB:0};window.emit=(id,event)=>RS.observeRuntimeFrame({type:'runtime_event',owner:owners[id],eventSequence:++seq[id],event});
      snapshot={ok:true,backendInstance:'fixture-backend',liveCount:2,totalCount:2,limit:3,hardLimit:3,items:['RA','RB'].map((id,i)=>{
        const owner=owners[id]={backendInstance:'fixture-backend',projectId:'project',repoId:'repo',workspaceId:id,workspaceEpoch:'epoch',conversationId:id,runtimeId:'runtime-'+id,runtimeGeneration:'generation',sessionId:'native-'+id};
        return {conversationId:id,title:id+' independent task',owner,revision:1,lifecycle:'ready',activity:'running',createdAt:String(i),workspace:{projectId:'project',repoId:'repo',workspaceId:id,workspaceEpoch:'epoch',branch:id}};
      })};RS.seedRuntimeSnapshot(snapshot);await NAV.loadRuntimeNav({path:fixtureCwd},{parent:document.querySelector('#pjSessionsBox')});
      for(const id of ['RA','RB']){emit(id,{type:'message_update',assistantMessageEvent:{type:'text_delta',delta:id+' output'}});emit(id,{type:'message_end',message:{role:'assistant',usage:{input:id==='RA'?11:22,output:3}}});emit(id,{type:'tool_execution_start',toolCallId:'same-tool',toolName:id+' tool'});emit(id,{type:'extension_ui_request',id:'same-approval',method:'confirm',title:id+' approval'});}
    })()`);
    await click('.pj-runtime[data-conversation-id="RA"] .pj-sess-primary');
    await waitFor(`WS.workspaceView()==='runtime'&&document.querySelector('.rtc-title').textContent.includes('RA')`);
    check(await read(`document.querySelector('.rtc-output').textContent==='RA output'&&document.querySelector('.ui2-runtime-usage').textContent.includes('输入 11')&&document.querySelector('.ui2-runtime-tools').textContent.includes('RA tool')&&document.querySelector('.rtc-approvals').textContent.includes('RA approval')`), 'RA output, tokens, tool and approval are owner-scoped');
    await read(`document.querySelectorAll('.rtc-controls button').forEach(b=>{if(b.textContent==='停止')b.id='stopRA'})`); await click('#stopRA');
    await click('.pj-runtime[data-conversation-id="RB"] .pj-sess-primary');
    check(await read(`runtimeActions.filter(a=>a.command?.type==='abort').length===1&&runtimeActions.find(a=>a.command?.type==='abort').owner.conversationId==='RA'&&RS.runtimeStore.get('RB').item.activity==='running'&&document.querySelector('.rtc-output').textContent==='RB output'&&document.querySelector('.ui2-runtime-usage').textContent.includes('输入 22')`), 'Stop RA does not stop or mix RB');
    await read(`document.querySelectorAll('.rtc-approvals button').forEach(b=>{if(b.textContent==='确认')b.id='allowRB'})`); await click('#allowRB');
    check(await read(`runtimeActions.filter(a=>a.command?.type==='extension_ui_response').length===1&&runtimeActions.find(a=>a.command?.type==='extension_ui_response').owner.conversationId==='RB'&&RS.runtimeStore.get('RA').approvals.length===1`), 'equal approval IDs remain scoped to RB while RA stays pending');
    await shot('runtime-B-owner-isolation');
    await click('.project:not(.active) .pj-select');
    check(await read(`WS.workspaceView()==='history'&&ST.S.cwd===fixtureCwd&&!otherWrites.includes('/api/projects/activate')`), 'project navigation preserves original execution cwd');
    check(await read(`!commands.some(c=>['abort','switch_session','new_session'].includes(c.type))&&!document.querySelector('#toasts').textContent.includes('正在生成回答')`), 'normal background navigation emits no destructive classic command or old restriction notice');
    const restored = await read(`(()=>{const items=snapshot.items.map(item=>({...item,revision:10,activity:'idle',nativeSessionId:item.owner.sessionId,lifecycle:item.conversationId==='RA'?'dormant':'ready',owner:item.conversationId==='RA'?null:item.owner}));return {...snapshot,items}})()`);
    // Install fixture transport before ES modules execute on a real page reload.
    // The backend snapshot is authoritative: RA has exited; RB is still reachable.
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
      const snapshot=${JSON.stringify(restored)},original=window.fetch.bind(window);window.recoveryActions=[];
      window.fetch=async(url,opt={})=>{const u=new URL(String(url),location.href),body=opt.body?JSON.parse(opt.body):null;let value;
        if(u.pathname==='/api/worktrees')value={ok:true,projectId:'project',items:[]};
        else if(u.pathname==='/api/runtime-sessions'&&!body&&u.searchParams.has('conversationId')){const id=u.searchParams.get('conversationId'),item=snapshot.items.find(i=>i.conversationId===id);value={ok:true,locator:{conversationId:id,projectId:'project',workspaceId:id,workspaceEpoch:'epoch',nativeSessionId:item.nativeSessionId},messages:[{role:'assistant',text:id+' persisted completion',userIndex:0}]};}
        else if(u.pathname==='/api/runtime-sessions'&&!body)value=snapshot;
        else if(u.pathname==='/api/runtime-sessions'){recoveryActions.push(body);value=body.action==='events'?{ok:true,owner:body.owner,cursor:0,events:[],approvals:[]}:{ok:true,owner:body.owner,data:body.command?.type==='get_messages'?{messages:[{role:'assistant',content:[{type:'text',text:body.owner.conversationId+' persisted completion'}]}]}:{models:[]}};}
        else return original(url,opt);
        return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
      };
    })()` });
    win.webContents.reload(); await new Promise(resolve => win.webContents.once('did-finish-load', resolve)); await sleep(900);
    await read(`(async()=>{window.RS=await import('/runtime-state.js');window.WS=await import('/ui/workspace-surface.js')})()`);
    try { await waitFor(`RS.runtimeStore.get('RB')?.text.includes('RB persisted completion')`); }
    catch(error) { console.error(await read(`JSON.stringify({actions:window.recoveryActions,records:RS.runtimeStore.values()})`)); throw error; }
    check(await read(`RS.runtimeStore.get('RA').item.lifecycle==='dormant'&&!RS.runtimeStore.get('RA').owner&&RS.runtimeStore.get('RB').approvals.length===0&&recoveryActions.every(a=>a.action==='events'||a.action==='read')`), 'real reload reads persisted result, never resumes exited RA or replays old approvals');
    await click('.pj-runtime[data-conversation-id="RA"] .pj-sess-primary');
    await waitFor(`document.querySelector('.rtc-output').textContent.includes('RA persisted completion')`);
    check(await read(`document.querySelector('.rtc-state').textContent.includes('未被启动')&&!recoveryActions.some(a=>['start','resume'].includes(a.action))`), 'reopened dormant session reads its proven native history without spawning a task');
    await shot('reload-persisted-result');
    check(errors.length === 0, 'no renderer/harness errors', errors);
  } catch (error) { check(false, 'runner completed', error.stack); }
  finally {
    clearTimeout(timeout); const failed = checks.filter(c => !c.pass).length;
    fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ passed: checks.length - failed, failed, checks, shots, errors }, null, 2));
    console.log(`Session background Electron: ${checks.length - failed}/${checks.length}; failed=${failed}; evidence=${out}`);
    win?.destroy(); harness?.kill(); app.exit(failed ? 1 : 0);
  }
}
