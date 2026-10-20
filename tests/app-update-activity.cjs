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
    const handlers=new Map(),frame={url:'http://127.0.0.1:7788/'};
    const wc={mainFrame:frame,isDestroyed:()=>false,send(){}};
    installAppUpdate({app:{isPackaged:false,getPath:()=>dir,getVersion:()=>version},ipcMain:{handle:(k,fn)=>handlers.set(k,fn),removeHandler:k=>handlers.delete(k)},
      origin:'http://127.0.0.1:7788',getWindow:()=>({webContents:wc}),getServer:()=>null,readUpdate:async()=>{throw Error('network forbidden');},quit:()=>{},dialog:{},shell:{}});
    const get=handlers.get('pi-gui:app-update-state'),valid={sender:wc,senderFrame:frame};
    assert.equal((await get(valid)).completion.phase,phase);
    for(const e of [{sender:{},senderFrame:frame},{sender:wc,senderFrame:{url:frame.url}},{sender:wc,senderFrame:Object.assign(frame,{url:'https://evil.test/'})}])assert.equal((await get(e)).code,'forbidden');
  }
  await checkVersion('0.27.0','completed');await checkVersion('0.26.2','failed');
});
