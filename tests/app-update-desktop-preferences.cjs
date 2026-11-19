const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');

const DESKTOP=path.join(__dirname,'../electron/app-update-desktop.cjs');
const tick=async()=>{for(let i=0;i<5;i+=1)await new Promise(resolve=>setImmediate(resolve));};
function world(t,{userData=null,backendOk=true,browserCount=0,dialogResponse=1,onDialog=null,readLatest='0.35.0'}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-desktop-prefs-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const temp=path.join(root,'temp'),profile=userData||path.join(root,'userData');
  fs.mkdirSync(temp,{recursive:true});fs.mkdirSync(profile,{recursive:true});
  const handlers=new Map(),sent=[],readCalls=[],frame={url:'http://127.0.0.1:7788/'};
  const wc={mainFrame:frame,isDestroyed:()=>false,send:(channel,payload)=>sent.push({channel,payload})};
  const app=new EventEmitter();Object.assign(app,{isPackaged:true,getPath:name=>name==='userData'?profile:temp,getVersion:()=>'0.34.0'});
  const server=new EventEmitter();server.connected=true;
  server.send=(request,callback)=>{
    queueMicrotask(()=>{
      const result=request.action==='inspect'&&!backendOk?{ok:false,code:'busy',error:'后台任务仍在运行'}:{ok:true};
      server.emit('message',{type:'app-update',id:request.id,...result});callback?.();
    });
  };
  const updater={state:{phase:'idle',mode:'installed',currentVersion:'0.34.0'},downloads:0,cancels:0,installs:0,quits:0,inspects:0,options:null,listener:null};
  const fakeModule={detectMode:()=> 'installed',createAppUpdate:options=>{
    updater.options=options;
    return {
      state:()=>({...updater.state}),
      onChange(fn){updater.listener=fn;return()=>{updater.listener=null;};},
      restore:async()=>{},
      async download(){updater.downloads+=1;updater.state={...updater.state,phase:'downloading',version:'0.35.0',received:50,total:100,speed:10};updater.listener?.();return {ok:true};},
      cancel(){updater.cancels+=1;updater.state={...updater.state,phase:'cancelled'};updater.listener?.();return {ok:true};},
      async install(request,options){updater.installCalls=(updater.installCalls||0)+1;if(options?.authorize&&options.authorize()!==true)return {ok:false,code:'revoked'};updater.installs+=1;return {ok:true};},
    };
  }};
  const req=name=>{
    if(name==='./app-update.cjs')return fakeModule;
    if(name.startsWith('./'))return require(path.resolve(path.dirname(DESKTOP),name));
    return require(name);
  };
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(DESKTOP,'utf8'),{require:req,module,exports:module.exports,__dirname:path.dirname(DESKTOP),process,setTimeout,clearTimeout,setInterval,clearInterval,URL,Promise,Buffer});
  const controller=module.exports.installAppUpdate({app,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},origin:'http://127.0.0.1:7788',
    getWindow:()=>({webContents:wc}),getServer:()=>server,
    readUpdate:async options=>{readCalls.push(options);return {ok:true,currentVersion:'0.34.0',latestVersion:readLatest,updateAvailable:true,
      release:{tag:`v${readLatest}`,url:`https://github.com/HYJ1817/pi-gui/releases/tag/v${readLatest}`,notes:'notes',assets:[]}};},
    inspectDesktop:()=>({ok:true,browsers:browserCount}),prepareDesktop:async()=>{},resumeBackend:async()=>{},
    dialog:{showMessageBox:async()=>{if(typeof onDialog==='function')await onDialog();return {response:dialogResponse};}},shell:{openPath:async()=>''},quit:()=>{updater.quits+=1;}});
  const call=(name,arg,event={sender:wc,senderFrame:frame})=>handlers.get(`pi-gui:app-update-${name}`)(event,arg);
  const ready=async version=>{updater.state={...updater.state,phase:'ready',version};updater.listener?.();await tick();};
  const preventEvent=()=>({prevented:false,preventDefault(){this.prevented=true;}});
  return {root,temp,profile,handlers,sent,readCalls,updater,controller,call,ready,preventEvent,app};
}

test('desktop preference IPC accepts only a fixed automatic/manual request and persists in userData',async t=>{
  if(process.platform!=='win32'){t.skip('Windows NSIS install shape');return;}
  const w=world(t);await tick();
  const initial=await w.call('state');
  assert.equal(initial.preference,'manual');
  assert.equal(initial.storedPreference,'manual');
  assert.equal(initial.automaticSupported,true);
  assert.equal(initial.automaticUnsupportedReason,null);
  assert.equal(fs.existsSync(path.join(w.profile,'app-update-preferences.json')),false,'reading state never writes a preference');

  assert.equal((await w.call('preference',{preference:'automatic',extra:true})).code,'untrusted');
  assert.equal((await w.call('preference',{preference:'disabled'})).code,'invalid_preference');
  assert.equal((await w.call('preference',null)).code,'untrusted');
  assert.equal((await w.call('state',undefined,{sender:{},senderFrame:{url:'http://127.0.0.1:7788/',mainFrame:{}}})).code,'forbidden');
  assert.equal(fs.existsSync(path.join(w.profile,'app-update-preferences.json')),false);

  const saved=await w.call('preference',{preference:'automatic'});
  assert.equal(saved.ok,true);
  assert.equal(saved.persisted,true);
  assert.equal(saved.snapshot.preference,'automatic');
  const file=path.join(w.profile,'app-update-preferences.json');
  assert.equal(fs.existsSync(file),true);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).preference,'automatic');
  assert.equal(fs.existsSync(path.join(w.temp,'app-update-preferences.json')),false,'preference is not written under the update cache');

  const again=world(t,{userData:w.profile});await tick();
  assert.equal((await again.call('state')).preference,'automatic','a new process reads the persisted preference');

  fs.writeFileSync(file,'{broken');
  const corrupt=world(t,{userData:w.profile});await tick();
  const state=await corrupt.call('state');
  assert.equal(state.preference,'manual','corrupt configuration fails safe');
  assert.equal(state.preferenceSaveFailed,false);
  assert.equal(fs.readFileSync(file,'utf8'),'{broken','startup does not overwrite the damaged file');
});

test('desktop check uses force, automatic download is single-flight, ignore cancels and ready blocks install-on-quit',async t=>{
  if(process.platform!=='win32'){t.skip('Windows NSIS install shape');return;}
  const w=world(t);await tick();
  assert.equal((await w.call('preference',{preference:'automatic'})).ok,true);
  const checked=await w.call('check');
  await tick();
  assert.equal(checked.ok,true);
  assert.deepEqual(w.readCalls[0],{force:true});
  assert.equal(w.updater.downloads,1,'automatic preference starts one background download');
  const state=await w.call('state');
  assert.equal(state.discovery.status,'available');
  assert.equal(state.discovery.latestVersion,'0.35.0');
  assert.equal(state.phase,'downloading');
  assert.equal(state.received,50);
  assert.equal(state.total,100);
  assert.equal(state.speed,10);

  const downloadCall=(await w.call('download',{confirm:true,url:'https://evil.example/x'})).code;
  assert.equal(downloadCall,'untrusted');
  assert.equal((await w.call('download',{confirm:false})).code,'untrusted');

  const ignored=await w.call('ignore');
  assert.equal(ignored.ok,true);
  assert.equal(ignored.snapshot.ignoredVersion,'0.35.0');
  assert.equal(ignored.snapshot.ignored,true);
  assert.equal(w.updater.cancels,1);
  assert.equal(ignored.snapshot.installOnQuit,false);
  const persisted=JSON.parse(fs.readFileSync(path.join(w.profile,'app-update-preferences.json'),'utf8'));
  assert.equal(persisted.ignoredVersion,'0.35.0');

  const unignored=await w.call('unignore');
  assert.equal(unignored.ok,true);
  assert.equal(unignored.snapshot.ignoredVersion,null);
  await tick();

  await w.ready('0.35.0');
  const readyState=await w.call('state');
  assert.equal(readyState.phase,'ready');
  assert.equal(readyState.installOnQuit,true);
  const before=w.updater.downloads;
  await w.call('check');await tick();
  assert.equal(w.updater.downloads,before,'periodic checks do not restart a ready target');
});

test('quit auto-install requires automatic, passes preflight and falls back safely',async t=>{
  if(process.platform!=='win32'){t.skip('Windows NSIS install shape');return;}
  {
    const w=world(t);await tick();await w.ready('0.35.0');
    const event=w.preventEvent();
    assert.equal(w.controller.beforeQuit(event),false,'manual preference must not auto install');
    assert.equal(event.prevented,false);
    await tick();
    assert.equal(w.updater.installs,0);
  }
  {
    const w=world(t);await tick();await w.call('preference',{preference:'automatic'});await w.ready('0.35.0');
    const event=w.preventEvent();
    assert.equal(w.controller.beforeQuit(event),true);
    assert.equal(event.prevented,true);
    assert.equal(w.controller.canQuit(),false);
    await tick();
    assert.equal(w.updater.installs,1);
    assert.equal(w.controller.canQuit(),true);
    assert.equal(w.controller.beforeQuit(w.preventEvent()),false);
    assert.equal(w.updater.installs,1,'a repeated quit event cannot install twice');
  }
  {
    const w=world(t,{backendOk:false});await tick();await w.call('preference',{preference:'automatic'});await w.ready('0.35.0');
    const event=w.preventEvent();
    assert.equal(w.controller.beforeQuit(event),true);
    await tick();
    assert.equal(w.updater.installs,0,'busy backend refuses auto install');
    assert.equal(w.updater.quits,1,'normal quit resumes after the refusal');
    assert.equal(w.controller.canQuit(),true);
  }
  {
    const w=world(t,{browserCount:1});await tick();await w.call('preference',{preference:'automatic'});await w.ready('0.35.0');
    const event=w.preventEvent();
    assert.equal(w.controller.beforeQuit(event),true);
    await tick();
    assert.equal(w.updater.installs,0,'an open browser may hold unsaved input');
    assert.equal(w.updater.quits,1);
  }
  {
    const w=world(t);await tick();await w.call('preference',{preference:'automatic'});await w.ready('0.35.0');
    w.controller.markSystemSessionEnding();
    const event=w.preventEvent();
    assert.equal(w.controller.beforeQuit(event),false);
    assert.equal(event.prevented,false);
    await tick();
    assert.equal(w.updater.installs,0,'system shutdown never starts a helper');
  }
});

test('explicit install revalidates the target and ignore state after the native dialog',async t=>{
  if(process.platform!=='win32'){t.skip('Windows NSIS install shape');return;}
  {
    let w;
    w=world(t,{dialogResponse:1,onDialog:async()=>{w.updater.state={...w.updater.state,version:'0.36.0'};}});
    await tick();await w.ready('0.35.0');
    const changed=await w.call('install',{confirm:true});
    assert.equal(changed.ok,false);
    assert.equal(changed.code,'revoked');
    assert.equal(w.updater.installCalls,1,'the native dialog result is rechecked before arming');
    assert.equal(w.updater.installs,0,'a changed target is never installed');
  }
  {
    let w;
    w=world(t,{dialogResponse:1,onDialog:async()=>{await w.call('ignore');}});
    await tick();await w.ready('0.35.0');
    const ignored=await w.call('install',{confirm:true});
    assert.equal(ignored.ok,false);
    assert.equal(ignored.code,'revoked');
    assert.equal(w.updater.installs,0,'ignoring during the dialog revokes the install');
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.profile,'app-update-preferences.json'),'utf8')).ignoredVersion,'0.35.0');
  }
  {
    let w;
    w=world(t,{dialogResponse:1,onDialog:async()=>{w.updater.state={...w.updater.state,phase:'failed'};}});
    await tick();await w.ready('0.35.0');
    const failed=await w.call('install',{confirm:true});
    assert.equal(failed.code,'revoked');
    assert.equal(w.updater.installs,0,'a package that is no longer ready is not installed');
  }
});

test('explicit install keeps confirmation, rejects ignored packages and still works in manual mode',async t=>{
  if(process.platform!=='win32'){t.skip('Windows NSIS install shape');return;}
  const w=world(t,{dialogResponse:1});await tick();await w.ready('0.35.0');
  assert.equal((await w.call('install',{confirm:true,extra:true})).code,undefined);
  // The extra key is rejected before the dialog; verify the explicit allowlist.
  assert.equal((await w.call('install',{confirm:true,extra:true})).ok,false);
  assert.equal((await w.call('install',{confirm:false})).ok,false);

  await w.call('ignore');
  const ignored=await w.call('install',{confirm:true});
  assert.equal(ignored.code,'ignored');
  assert.equal(w.updater.installs,0,'ignored ready package cannot be installed explicitly either');
  await w.call('unignore');

  const manual=await w.call('preference',{preference:'manual'});
  assert.equal(manual.ok,true);
  const installed=await w.call('install',{confirm:true});
  assert.equal(installed.ok,true);
  assert.equal(w.updater.installs,1,'manual preference still permits an explicit install');

  assert.equal((await w.call('cancel')).code,'not_downloading');
  assert.equal((await w.call('state')).preference,'manual');
});
