const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const tick=()=>new Promise(r=>setImmediate(r));
test('classic bridge tracks pending approvals, commands and RPC before update',async()=>{
  const {createRpcBridge}=await import('../server/rpc-bridge.js'),{createRuntime}=await import('../server/runtime.js');
  const runtime=createRuntime({initialCwd:os.tmpdir()});const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
  const rpc=createRpcBridge({runtime,publish:()=>{},piBin:'fake',isWin:false,env:{},autoRestart:false,spawnProcess:()=>child});
  rpc.start();child.emit('spawn');await tick();
  const emit=event=>child.stdout.write(JSON.stringify(event)+'\n');
  // Finish any readiness probes, using the real wire shape.
  const input=child.stdin.read()?.toString()||'';
  for(const line of input.trim().split('\n').filter(Boolean)){const cmd=JSON.parse(line);emit({type:'response',id:cmd.id,command:cmd.type,success:true,data:{sessionId:'fixture'}});}
  await tick();
  emit({type:'extension_ui_request',method:'confirm',id:'approval-1',title:'fixture'});assert.equal(rpc.updateBusy(),true);
  rpc.send({type:'extension_ui_response',id:'approval-1',confirmed:false});assert.equal(rpc.updateBusy(),false);
  rpc.send({type:'set_session_name',id:'command-1',name:'fixture'});assert.equal(rpc.updateBusy(),true);
  emit({type:'response',id:'command-1',command:'set_session_name',success:true});await tick();assert.equal(rpc.updateBusy(),false);
  const request=rpc.request({type:'get_state'});assert.equal(rpc.updateBusy(),true);
  const buffered=child.stdin.read().toString().trim().split('\n').map(JSON.parse).findLast(c=>c.type==='get_state');
  emit({type:'response',id:buffered.id,command:'get_state',success:true,data:{sessionId:'fixture'}});await request;assert.equal(rpc.updateBusy(),false);
  const internal=rpc.request({type:'get_state'});
  const query=child.stdin.read().toString().trim().split('\n').map(JSON.parse).findLast(c=>c.type==='get_state');
  rpc.send({type:'set_session_name',id:String(query.id),name:'same numeric text'});
  emit({type:'response',id:query.id,command:'get_state',success:true,data:{sessionId:'fixture'}});await internal;
  assert.equal(rpc.updateBusy(),true,'internal numeric response cannot settle a same-text renderer command id');
  emit({type:'response',id:String(query.id),command:'set_session_name',success:true});await tick();assert.equal(rpc.updateBusy(),false);
  runtime.setShuttingDown(true);child.emit('exit',0);
});
test('idle runtime with pending approval cannot pass app update maintenance',async t=>{
  const {createRuntimeRegistry}=await import('../server/runtime-registry.js');
  const {createAppUpdateMaintenance}=await import('../server/app-update-maintenance.js');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-approval-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const w={projectId:'p',repoId:'r',workspaceId:'w',workspaceEpoch:'e',cwd:dir,root:dir};let publish,disposed=false;
  const r=createRuntimeRegistry({dataDir:dir,resolveWorkspace:async()=>w,validateWorkspace:async()=>{},factory:async(_context,emit)=>{
    publish=emit;return {start(){emit({type:'bridge_status',state:'ready',bridgeRun:1});},getState:()=>({state:'ready'}),request:async()=>({sessionId:'fixture'}),
      send(){},dispose:async()=>{disposed=true;},cleanupConfirmed:()=>disposed};
  }});
  await r.start({id:'w',epoch:'e'});await tick();
  publish({type:'extension_ui_request',method:'confirm',id:'approval-1',title:'fixture'});
  assert.equal(r.busy(),false);assert.equal(r.updateBusy(),true);
  const gate=createAppUpdateMaintenance({busyReason:()=>r.busy()?{code:'busy-runtime'}:null,otherBusy:()=>r.updateBusy(),closeSessions:()=>r.closeAll(),pause:async()=>({ok:true}),resume:()=>{}});
  assert.equal((await gate.prepare()).ok,false);assert.equal(disposed,false);await r.dispose();
});
test('main IPC denies foreign window, subframe and wrong origin; startup version is rechecked',async t=>{
  const {installAppUpdate}=require('../electron/app-update-desktop.cjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-ipc-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const root=path.join(dir,'pi-gui-updates'),run=path.join(root,'install-fixture');fs.mkdirSync(run,{recursive:true});
  fs.writeFileSync(path.join(root,'pending.json'),JSON.stringify({run:'install-fixture',expectedVersion:'0.27.0'}));
  fs.writeFileSync(path.join(run,'result.json'),JSON.stringify({phase:'installed'}));
  async function checkVersion(version,phase){
    fs.writeFileSync(path.join(root,'pending.json'),JSON.stringify({run:'install-fixture',expectedVersion:'0.27.0'}));
    const handlers=new Map(),frame={url:'http://127.0.0.1:7788/'};
    const wc={mainFrame:frame,isDestroyed:()=>false,send(){}};
    installAppUpdate({app:{isPackaged:false,getPath:()=>dir,getVersion:()=>version},ipcMain:{handle:(k,fn)=>handlers.set(k,fn),removeHandler:k=>handlers.delete(k)},
      origin:'http://127.0.0.1:7788',getWindow:()=>({webContents:wc}),getServer:()=>null,readUpdate:async()=>{throw Error('network forbidden');},quit:()=>{},dialog:{},shell:{}});
    const get=handlers.get('pi-gui:app-update-state'),valid={sender:wc,senderFrame:frame};
    assert.equal((await get(valid)).completion.phase,phase);
    assert.equal(fs.existsSync(path.join(root,'pending.json')),false,'terminal result is consumed');
    for(const e of [{sender:{},senderFrame:frame},{sender:wc,senderFrame:{url:frame.url}},{sender:wc,senderFrame:Object.assign(frame,{url:'https://evil.test/'})}])assert.equal((await get(e)).code,'forbidden');
  }
  await checkVersion('0.27.0','completed');await checkVersion('0.26.2','failed');
});

function recoveryDesktop(t,version='0.27.0') {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-recovery-'));
  const fixture={};t.after(async()=>{await fixture.stop?.();fs.rmSync(dir,{recursive:true,force:true});});
  const root=path.join(dir,'pi-gui-updates'),run=path.join(root,'install-fixture');fs.mkdirSync(run,{recursive:true});
  const pending=path.join(root,'pending.json'),result=path.join(run,'result.json');
  fs.writeFileSync(pending,JSON.stringify({run:'install-fixture',expectedVersion:'0.27.0'}));
  function start(){
    const handlers=new Map(),frame={url:'http://127.0.0.1:7788/'},sent=[];
    const wc={mainFrame:frame,isDestroyed:()=>false,send:(_name,value)=>sent.push(value)};
    const app=new EventEmitter();Object.assign(app,{isPackaged:false,getPath:()=>dir,getVersion:()=>version});
    require('../electron/app-update-desktop.cjs').installAppUpdate({app,ipcMain:{handle:(k,fn)=>handlers.set(k,fn)},
      origin:'http://127.0.0.1:7788',getWindow:()=>({webContents:wc}),getServer:()=>null,
      readUpdate:async()=>{throw Error('network forbidden');},quit(){},dialog:{},shell:{}});
    t.after(()=>app.emit('before-quit'));
    const call=(name,...args)=>handlers.get(`pi-gui:app-update-${name}`)({sender:wc,senderFrame:frame},...args);
    return {call,sent,app};
  }
  return Object.assign(fixture,{root,pending,result,start});
}
test('terminal recovery is reported once; missing and unsuccessful results fail safely',async t=>{
  for(const phase of ['installed','rolled_back','installer_timeout','restart_failed',null]){
    const fixture=recoveryDesktop(t);if(phase)fs.writeFileSync(fixture.result,JSON.stringify({phase}));
    const first=fixture.start();assert.equal((await first.call('state')).completion.phase,phase==='installed'?'completed':'failed');
    assert.equal(fs.existsSync(fixture.pending),false);
    assert.equal((await fixture.start().call('state')).completion,undefined,'consumed result is not repeated on next launch');
  }
});
test('active helper remains waiting, blocks another update, then publishes and consumes its result',async t=>{
  if(process.platform!=='win32'){t.skip('Windows FileShare.None lock');return;}
  const fixture=recoveryDesktop(t),{spawn}=require('node:child_process');
  const child=spawn(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',
    "$lock=[IO.File]::Open($env:PI_UPDATE_TEST_LOCK,'OpenOrCreate','ReadWrite','None');[Console]::Out.WriteLine('locked');while(!(Test-Path ($env:PI_UPDATE_TEST_LOCK+'.release'))){Start-Sleep -Milliseconds 50};$lock.Dispose()"],
    {env:{...process.env,PI_UPDATE_TEST_LOCK:path.join(fixture.root,'install.lock')},stdio:['pipe','pipe','pipe'],windowsHide:true});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  fixture.stop=async()=>{fs.writeFileSync(path.join(fixture.root,'install.lock.release'),'release');await exited;};
  await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('lock holder exited before ready')));});
  const desktop=fixture.start();
  assert.equal((await desktop.call('state')).completion.phase,'waiting','no result while helper runs is not a failure');
  assert.equal((await desktop.call('download',{confirm:true})).code,'update_pending');
  assert.equal((await desktop.call('install',{confirm:true})).code,'update_pending');
  assert.equal(fs.existsSync(fixture.pending),true);
  fs.writeFileSync(fixture.result,JSON.stringify({phase:'installed'}));
  assert.equal((await desktop.call('state')).completion.phase,'waiting','a result does not bypass the live installer lock');
  await fixture.stop();
  // No renderer request is needed to publish completion after helper exit.
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{clearInterval(poll);reject(Error('completion event timeout'));},4000);
    const poll=setInterval(()=>{if(desktop.sent.some(s=>s.completion?.phase==='completed')){clearTimeout(timeout);clearInterval(poll);resolve();}},20);});
  assert.equal((await desktop.call('state')).completion.phase,'completed');
  assert.equal(fs.existsSync(fixture.pending),false);
});
test('recovery rejects traversal and linked pending files without deleting their targets',async t=>{
  const fixture=recoveryDesktop(t);
  fs.writeFileSync(fixture.pending,JSON.stringify({run:'../outside',expectedVersion:'0.27.0'}));
  assert.notEqual((await fixture.start().call('state')).completion?.phase,'completed');
  const target=path.join(fixture.root,'target.json');fs.writeFileSync(target,JSON.stringify({run:'install-fixture',expectedVersion:'0.27.0'}));
  fs.unlinkSync(fixture.pending);fs.linkSync(target,fixture.pending);fs.writeFileSync(fixture.result,JSON.stringify({phase:'installed'}));
  assert.notEqual((await fixture.start().call('state')).completion?.phase,'completed');
  assert.equal(fs.existsSync(target),true);assert.equal(fs.existsSync(fixture.pending),true);
});
