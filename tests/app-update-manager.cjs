const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createPreferenceStore}=require('../electron/app-update-policy.cjs');
const {createAppUpdateManager}=require('../electron/app-update-manager.cjs');

const CURRENT='0.34.0';

function tempFile(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-manager-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return path.join(dir,'app-update-preferences.json');
}
function makeStore(t,{preference='manual',ignoredVersion=null,pausedVersion=null,lastNotifiedVersion=null}={}){
  const store=createPreferenceStore({file:tempFile(t)});
  store.update({preference,ignoredVersion,pausedVersion,lastNotifiedVersion});
  return store;
}
function updatePayload({version='0.35.0',available=true,currentVersion=CURRENT,tag=`v${version}`}={}){
  return {ok:true,currentVersion,latestVersion:version,updateAvailable:available,cached:false,
    release:available?{tag,url:`https://github.com/HYJ1817/pi-gui/releases/tag/${tag}`,notes:`notes ${version}`,assets:[]}:null};
}
function makeUpdater(initial={phase:'idle',mode:'installed',currentVersion:CURRENT,received:0,total:0,speed:0}){
  let state={...initial};
  const listeners=new Set();
  const calls={download:[],cancel:0,install:[]};
  const updater={
    calls,
    state:()=>({...state}),
    onChange(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    emit(next){state={...state,...next};for(const fn of [...listeners])fn({...state});},
    async download(request){
      calls.download.push(request);
      if(updater.onDownload)return updater.onDownload(request);
      updater.emit({phase:'downloading',version:'0.35.0'});
      return {ok:true};
    },
    cancel(){calls.cancel+=1;updater.emit({phase:'cancelled'});return {ok:true};},
    async install(request){calls.install.push(request);return {ok:true};},
  };
  return updater;
}
function makeManager({t,updater,store,readUpdate,mode='installed',platform='win32',packaged=true,notifications=[],publishes=[],isBlocked=()=>false, timers}){
  const manager=createAppUpdateManager({
    updater,store,mode,currentVersion:CURRENT,platform,packaged,readUpdate,
    notify:notice=>notifications.push(notice),
    publish:snapshot=>publishes.push(snapshot),
    isBlocked,
    initialDelayMs:timers?timers.initialDelayMs??15000:15000,
    intervalMs:timers?timers.intervalMs??6*60*60*1000:6*60*60*1000,
    setTimeoutImpl:timers?timers.setTimeoutImpl:setTimeout,
    clearTimeoutImpl:timers?timers.clearTimeoutImpl:clearTimeout,
    setIntervalImpl:timers?timers.setIntervalImpl:setInterval,
    clearIntervalImpl:timers?timers.clearIntervalImpl:clearInterval,
  });
  return manager;
}

test('manual preference checks, notifies once per version and never downloads',async t=>{
  const store=makeStore(t),updater=makeUpdater(),notifications=[];
  let read=0,forceSeen=null;
  const manager=makeManager({t,updater,store,notifications,
    readUpdate:async({force}={})=>{read+=1;forceSeen=force;return updatePayload();}});
  const first=await manager.check({manual:true,force:true});
  assert.equal(first.ok,true);
  assert.equal(read,1);
  assert.equal(forceSeen,true);
  assert.equal(updater.calls.download.length,0);
  assert.deepEqual(notifications.map(n=>[n.kind,n.version]),[['available','0.35.0']]);
  assert.equal(store.snapshot().lastNotifiedVersion,'0.35.0');
  await manager.check({manual:true,force:true});
  assert.equal(notifications.length,1,'the same version must not notify twice');
  assert.equal(manager.snapshot().discovery.status,'available');
  assert.equal(manager.snapshot().preference,'manual');
  manager.dispose();
});

test('a background notification bookmark never repairs a corrupt preference file',async t=>{
  const file=tempFile(t);fs.writeFileSync(file,'{not json');
  const store=createPreferenceStore({file}),updater=makeUpdater(),notifications=[];
  const manager=makeManager({t,updater,store,notifications,readUpdate:async()=>updatePayload()});
  await manager.check({manual:false});
  assert.equal(fs.readFileSync(file,'utf8'),'{not json','a background check must not overwrite the corrupt file');
  assert.equal(notifications.length,1);
  assert.equal(store.snapshot().lastNotifiedVersion,'0.35.0');
  manager.dispose();
});

test('automatic preference downloads once, reports progress and never notifies a manual reminder',async t=>{
  const store=makeStore(t,{preference:'automatic'}),updater=makeUpdater(),notifications=[],publishes=[];
  let read=0;
  const manager=makeManager({t,updater,store,notifications,publishes,readUpdate:async()=>{read+=1;return updatePayload();}});
  await manager.check({manual:true,force:true});
  await manager.whenIdle();
  assert.equal(read,1);
  assert.equal(updater.calls.download.length,1);
  assert.deepEqual(updater.calls.download[0],{confirm:true});
  assert.equal(notifications.length,0);
  updater.emit({phase:'downloading',version:'0.35.0',received:512,total:1024,speed:128});
  await manager.check({manual:true,force:true});
  await manager.whenIdle();
  assert.equal(updater.calls.download.length,1,'a repeated check must not start a duplicate download');
  assert.equal(manager.snapshot().received,512);
  assert.equal(manager.snapshot().total,1024);
  assert.equal(manager.snapshot().speed,128);
  manager.dispose();
});

test('start schedules fifteen seconds then six hours without a renderer page',async t=>{
  const store=makeStore(t),updater=makeUpdater(),timeouts=[],intervals=[];
  let reads=0;
  const manager=makeManager({t,updater,store,
    timers:{setTimeoutImpl:(fn,ms)=>{timeouts.push({fn,ms});return {unref(){}};},
      clearTimeoutImpl:()=>{},setIntervalImpl:(fn,ms)=>{intervals.push({fn,ms});return {unref(){}};},clearIntervalImpl:()=>{}},
    readUpdate:async()=>{reads+=1;return updatePayload({available:false,version:CURRENT});}});
  manager.start();manager.start();
  assert.equal(timeouts.length,1);
  assert.equal(timeouts[0].ms,15000);
  assert.equal(intervals.length,1);
  assert.equal(intervals[0].ms,6*60*60*1000);
  timeouts[0].fn();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,1);
  intervals[0].fn();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,2);
  manager.dispose();
});

test('check requests are single-flight even when forced twice',async t=>{
  const store=makeStore(t),updater=makeUpdater();
  let reads=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const manager=makeManager({t,updater,store,readUpdate:async()=>{reads+=1;await gate;return updatePayload();}});
  const a=manager.check({manual:true,force:true});
  const b=manager.check({manual:true,force:true});
  assert.equal(reads,1);
  release();
  await Promise.all([a,b]);
  assert.equal(reads,1);
  manager.dispose();
});

test('a manual check upgrades an in-flight unforced background check',async t=>{
  const store=makeStore(t),updater=makeUpdater();
  let reads=0,release;const forces=[];
  const gate=new Promise(resolve=>{release=resolve;});
  const manager=makeManager({t,updater,store,readUpdate:async({force}={})=>{
    reads+=1;forces.push(force);
    if(reads===1)await gate;
    return updatePayload({available:false,version:CURRENT});
  }});
  const auto=manager.check({manual:false});
  const manual=manager.check({manual:true,force:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,1,'only one request is in flight at a time');
  release();
  await Promise.all([auto,manual]);
  assert.equal(reads,2,'the manual request still gets its own forced read');
  assert.deepEqual(forces,[false,true]);
  manager.dispose();
});

test('manual check bypasses cache while automatic check uses it',async t=>{
  const store=makeStore(t),updater=makeUpdater();
  const forces=[];
  const manager=makeManager({t,updater,store,readUpdate:async({force}={})=>{forces.push(force);return updatePayload({available:false,version:CURRENT});}});
  await manager.check({manual:false});
  await manager.check({manual:true,force:true});
  assert.deepEqual(forces,[false,true]);
  manager.dispose();
});

test('malformed upstream versions, release tags and current versions never reach download',async t=>{
  const cases=[
    {name:'malformed latest',payload:{...updatePayload(),latestVersion:'0.35'}},
    {name:'tag mismatch',payload:{...updatePayload(),release:{tag:'v0.36.0'}}},
    {name:'current mismatch',payload:{...updatePayload(),currentVersion:'0.33.0'}},
    {name:'prerelease',payload:{...updatePayload(),latestVersion:'0.35.0-beta.1'}},
    {name:'service failure',payload:{ok:false,error:'rate limited',code:'rate_limited'}},
  ];
  for(const entry of cases){
    const store=makeStore(t,{preference:'automatic'}),updater=makeUpdater();
    const manager=makeManager({t,updater,store,readUpdate:async()=>entry.payload});
    const result=await manager.check({manual:true,force:true});
    await manager.whenIdle();
    assert.equal(result.ok,false,entry.name);
    assert.equal(updater.calls.download.length,0,entry.name);
    assert.equal(manager.snapshot().discovery.status,'error',entry.name);
    manager.dispose();
  }
});

test('background check failure preserves a previously discovered version',async t=>{
  const store=makeStore(t),updater=makeUpdater();
  let calls=0;
  const manager=makeManager({t,updater,store,readUpdate:async()=>{
    calls+=1;
    if(calls===1)return updatePayload();
    throw Error('offline');
  }});
  await manager.check({manual:true,force:true});
  const result=await manager.check({manual:false});
  assert.equal(result.ok,false);
  assert.equal(manager.snapshot().discovery.status,'available');
  assert.equal(manager.snapshot().discovery.latestVersion,'0.35.0');
  assert.equal(manager.snapshot().discovery.error,'');
  manager.dispose();
});

test('a manual check failure is surfaced as a retryable error',async t=>{
  const store=makeStore(t),updater=makeUpdater();
  const manager=makeManager({t,updater,store,readUpdate:async()=>{throw Error('offline');}});
  const result=await manager.check({manual:true,force:true});
  assert.equal(result.ok,false);
  assert.match(result.error,/offline/);
  assert.equal(manager.snapshot().discovery.status,'error');
  manager.dispose();
});

test('unsupported installations reject automatic and still notify as manual',async t=>{
  for(const scenario of [
    {name:'portable',mode:'portable',platform:'win32',packaged:true,reason:'portable'},
    {name:'development',mode:'development',platform:'win32',packaged:false,reason:'development'},
    {name:'other platform',mode:'installed',platform:'darwin',packaged:true,reason:'platform'},
  ]){
    const store=makeStore(t,{preference:'automatic'}),updater=makeUpdater(),notifications=[];
    const manager=makeManager({t,updater,store,notifications,mode:scenario.mode,platform:scenario.platform,packaged:scenario.packaged,
      readUpdate:async()=>updatePayload()});
    assert.equal(manager.snapshot().preference,'manual',scenario.name);
    assert.equal(manager.snapshot().automaticSupported,false,scenario.name);
    assert.equal(manager.snapshot().automaticUnsupportedReason,scenario.reason,scenario.name);
    const rejected=manager.setPreference('automatic');
    assert.equal(rejected.ok,false,scenario.name);
    assert.equal(rejected.code,'unsupported',scenario.name);
    assert.equal(store.snapshot().preference,'automatic','store is left untouched by a rejected switch',scenario.name);
    await manager.check({manual:true,force:true});
    await manager.whenIdle();
    assert.equal(updater.calls.download.length,0,scenario.name);
    assert.equal(notifications.length,1,scenario.name);
    manager.dispose();
  }
});

test('switching automatic to manual cancels an automatic download and keeps a ready package',async t=>{
  const store=makeStore(t,{preference:'automatic'}),updater=makeUpdater(),notifications=[];
  let releaseDownload;
  updater.onDownload=()=>{updater.emit({phase:'downloading',version:'0.35.0'});return new Promise(resolve=>{releaseDownload=resolve;});};
  const manager=makeManager({t,updater,store,notifications,readUpdate:async()=>updatePayload()});
  await manager.check({manual:true,force:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(updater.calls.download.length,1);
  assert.deepEqual(manager.snapshot().phase,'downloading');
  const switched=manager.setPreference('manual');
  assert.equal(switched.ok,true);
  assert.equal(updater.calls.cancel,1);
  assert.equal(store.snapshot().pausedVersion,null,'switching mode is not a user cancellation');
  releaseDownload({ok:false,code:'cancelled'});
  await manager.whenIdle();
  updater.emit({phase:'ready',version:'0.35.0'});
  assert.equal(manager.snapshot().phase,'ready');
  assert.equal(manager.snapshot().preference,'manual');
  assert.equal(manager.snapshot().installOnQuit,false);
  assert.equal(updater.calls.download.length,1);
  manager.dispose();
});

test('switching manual to automatic reuses ready or starts one available download',async t=>{
  const store=makeStore(t),updater=makeUpdater();
  const manager=makeManager({t,updater,store,readUpdate:async()=>updatePayload()});
  await manager.check({manual:true,force:true});
  assert.equal(updater.calls.download.length,0);
  updater.emit({phase:'ready',version:'0.35.0'});
  manager.setPreference('automatic');
  await manager.whenIdle();
  assert.equal(updater.calls.download.length,0,'verified cache for the same target is reused');
  updater.emit({phase:'idle'});
  manager.setPreference('manual');
  manager.setPreference('automatic');
  await manager.whenIdle();
  assert.equal(updater.calls.download.length,1);
  manager.dispose();
});

test('a newer release starts a fresh download without overwriting a ready state by checks',async t=>{
  const store=makeStore(t,{preference:'automatic'}),updater=makeUpdater({phase:'ready',mode:'installed',currentVersion:CURRENT,version:'0.35.0'});
  let latest='0.35.0';
  const manager=makeManager({t,updater,store,readUpdate:async()=>updatePayload({version:latest})});
  await manager.check({manual:true,force:true});
  await manager.whenIdle();
  assert.equal(updater.calls.download.length,0,'ready for the current target stays untouched');
  assert.equal(manager.snapshot().phase,'ready');
  latest='0.36.0';
  await manager.check({manual:true,force:true});
  await manager.whenIdle();
  assert.equal(updater.calls.download.length,1,'a newer release may replace the pending target');
  manager.dispose();
});

test('ready emits one lightweight notice only in supported automatic mode',async t=>{
  const store=makeStore(t,{preference:'automatic'}),updater=makeUpdater(),notifications=[];
  const manager=makeManager({t,updater,store,notifications,readUpdate:async()=>updatePayload({available:false,version:CURRENT})});
  updater.emit({phase:'ready',version:'0.35.0'});
  updater.emit({phase:'ready',version:'0.35.0'});
  assert.deepEqual(notifications.map(n=>[n.kind,n.version]),[['ready','0.35.0']]);
  assert.equal(manager.snapshot().installOnQuit,true);
  manager.dispose();
});

test('cancel pauses the exact version, survives a restart and is cleared by an explicit download',async t=>{
  const store=makeStore(t,{preference:'automatic'}),updater=makeUpdater();
  updater.onDownload=()=>{updater.emit({phase:'downloading',version:'0.35.0',received:10,total:100});return new Promise(()=>{});};
  const manager=makeManager({t,updater,store,readUpdate:async()=>updatePayload()});
  await manager.check({manual:true,force:true});
  await new Promise(resolve=>setImmediate(resolve));
  const cancelled=manager.cancel();
  assert.equal(cancelled.ok,true);
  assert.equal(cancelled.version,'0.35.0');
  assert.equal(store.snapshot().pausedVersion,'0.35.0');
  assert.equal(updater.calls.cancel,1);
  manager.dispose();

  const updater2=makeUpdater(),store2=createPreferenceStore({file:store.file}),notifications2=[];
  const manager2=makeManager({t,updater:updater2,store:store2,notifications:notifications2,readUpdate:async()=>updatePayload()});
  assert.equal(manager2.snapshot().paused,true);
  await manager2.check({manual:true,force:true});
  await manager2.whenIdle();
  assert.equal(updater2.calls.download.length,0,'a paused version is not auto-retried after restart');
  assert.equal(notifications2.length,0,'cancel already informed the user');
  const download=await manager2.download();
  assert.equal(download.ok,true);
  assert.equal(store2.snapshot().pausedVersion,null,'an explicit download clears the pause');
  assert.equal(updater2.calls.download.length,1);
  manager2.dispose();
});

test('a newer release clears a pause and automatic delivery resumes',async t=>{
  const store=makeStore(t,{preference:'automatic',pausedVersion:'0.35.0'}),updater=makeUpdater();
  const manager=makeManager({t,updater,store,readUpdate:async()=>updatePayload({version:'0.36.0'})});
  await manager.check({manual:true,force:true});
  await manager.whenIdle();
  assert.equal(store.snapshot().pausedVersion,null);
  assert.equal(updater.calls.download.length,1);
  manager.dispose();
});

test('ignore only suppresses the displayed version, persists and blocks auto install',async t=>{
  const store=makeStore(t,{preference:'automatic'}),updater=makeUpdater(),notifications=[];
  updater.onDownload=()=>{updater.emit({phase:'downloading',version:'0.35.0',received:1,total:2});return new Promise(()=>{});};
  const manager=makeManager({t,updater,store,notifications,readUpdate:async()=>updatePayload()});
  await manager.check({manual:true,force:true});
  await new Promise(resolve=>setImmediate(resolve));
  const ignored=manager.ignore();
  assert.equal(ignored.ok,true);
  assert.equal(store.snapshot().ignoredVersion,'0.35.0');
  assert.equal(updater.calls.cancel,1,'an in-flight download for the ignored version is cancelled');
  assert.equal(manager.snapshot().ignored,true);
  assert.equal(manager.snapshot().installOnQuit,false);
  manager.dispose();

  const manager2=makeManager({t,updater:makeUpdater(),store:createPreferenceStore({file:store.file}),notifications:[],
    readUpdate:async()=>updatePayload({available:false,version:CURRENT})});
  assert.equal(manager2.snapshot().ignoredVersion,'0.35.0');
  manager2.dispose();

  const store3=createPreferenceStore({file:store.file}),updater3=makeUpdater();
  const manager3=makeManager({t,updater:updater3,store:store3,readUpdate:async()=>updatePayload({version:'0.36.0'})});
  await manager3.check({manual:true,force:true});
  await manager3.whenIdle();
  assert.equal(store3.snapshot().ignoredVersion,null,'a newer version clears the ignore');
  assert.equal(updater3.calls.download.length,1);
  manager3.dispose();
});

test('ignoring a ready package uses the displayed package, not a newer discovered release',async t=>{
  const store=makeStore(t,{preference:'manual'}),updater=makeUpdater({phase:'ready',mode:'installed',currentVersion:CURRENT,version:'0.35.0'});
  const manager=makeManager({t,updater,store,readUpdate:async()=>updatePayload({version:'0.36.0'})});
  await manager.check({manual:true,force:true});
  const ignored=manager.ignore();
  assert.equal(ignored.ok,true);
  assert.equal(ignored.version,'0.35.0');
  assert.equal(store.snapshot().ignoredVersion,'0.35.0','the ready package shown by the UI is the one ignored');
  assert.equal(manager.snapshot().ignored,true);
  store.setPreference('automatic');
  assert.equal(manager.snapshot().installOnQuit,false);
  assert.equal(manager.autoInstallCandidate().code,'ignored');
  manager.dispose();
});

test('ignored ready packages cannot auto-install and can be unignored',async t=>{
  const store=makeStore(t,{preference:'automatic',ignoredVersion:'0.35.0'}),updater=makeUpdater({phase:'ready',mode:'installed',currentVersion:CURRENT,version:'0.35.0'});
  const manager=makeManager({t,updater,store,readUpdate:async()=>updatePayload({available:false,version:CURRENT})});
  assert.equal(manager.snapshot().ignored,true);
  assert.equal(manager.snapshot().installOnQuit,false);
  assert.equal(manager.autoInstallCandidate().code,'ignored');
  const result=manager.unignore();
  assert.equal(result.ok,true);
  assert.equal(store.snapshot().ignoredVersion,null);
  assert.equal(manager.snapshot().installOnQuit,true);
  manager.dispose();
});

test('install authorization survives preparing but tracks preference, ignore and pause',async t=>{
  const store=makeStore(t,{preference:'automatic'}),updater=makeUpdater({phase:'ready',mode:'installed',currentVersion:CURRENT,version:'0.35.0'});
  const manager=makeManager({t,updater,store,readUpdate:async()=>updatePayload({version:'0.35.0'})});
  assert.equal(manager.autoInstallStillAllowed(),true);
  updater.emit({phase:'preparing',version:'0.35.0'});
  assert.equal(manager.autoInstallStillAllowed(),true,'phase may change once the install starts');
  store.setPreference('manual');
  assert.equal(manager.autoInstallStillAllowed(),false,'switching to manual revokes the running auto install');
  store.setPreference('automatic');
  store.update({ignoredVersion:'0.35.0'});
  assert.equal(manager.autoInstallStillAllowed(),false,'ignoring the exact version revokes it');
  store.update({ignoredVersion:null,pausedVersion:'0.35.0'});
  assert.equal(manager.autoInstallStillAllowed(),false,'pausing the exact version revokes it');
  store.update({pausedVersion:null});
  assert.equal(manager.autoInstallStillAllowed(),true);
  manager.dispose();
  assert.equal(manager.autoInstallStillAllowed(),false);
});

test('auto install eligibility requires every safe condition',async t=>{
  const cases=[
    {name:'manual',preference:'manual',version:'0.35.0',expected:'preference'},
    {name:'not ready',preference:'automatic',version:'0.35.0',phase:'downloading',expected:'not-ready'},
    {name:'not newer',preference:'automatic',version:CURRENT,expected:'not-newer'},
    {name:'invalid version',preference:'automatic',version:'0.35',expected:'invalid-version'},
    {name:'ignored',preference:'automatic',version:'0.35.0',ignoredVersion:'0.35.0',expected:'ignored'},
    {name:'paused',preference:'automatic',version:'0.35.0',pausedVersion:'0.35.0',expected:'paused'},
  ];
  for(const c of cases){
    const store=makeStore(t,{preference:c.preference,ignoredVersion:c.ignoredVersion??null,pausedVersion:c.pausedVersion??null});
    const updater=makeUpdater({phase:c.phase||'ready',mode:'installed',currentVersion:CURRENT,version:c.version});
    const manager=makeManager({t,updater,store,readUpdate:async()=>updatePayload({available:false,version:CURRENT})});
    const candidate=manager.autoInstallCandidate();
    assert.equal(candidate.ok,false,c.name);
    assert.equal(candidate.code,c.expected,c.name);
    manager.dispose();
  }
  const store=makeStore(t,{preference:'automatic'}),updater=makeUpdater({phase:'ready',mode:'installed',currentVersion:CURRENT,version:'0.35.0'});
  const blocked=makeManager({t,updater,store,isBlocked:()=>true,readUpdate:async()=>updatePayload({available:false,version:CURRENT})});
  assert.equal(blocked.autoInstallCandidate().code,'blocked');
  blocked.dispose();
});

test('download failure is reported without a notification loop or a pause',async t=>{
  const store=makeStore(t,{preference:'automatic'}),updater=makeUpdater(),notifications=[];
  updater.download=async request=>{updater.calls.download.push(request);return {ok:false,code:'network',error:'网络中断'};};
  const manager=makeManager({t,updater,store,notifications,readUpdate:async()=>updatePayload()});
  await manager.check({manual:true,force:true});
  await manager.whenIdle();
  assert.equal(updater.calls.download.length,1);
  assert.equal(notifications.length,0);
  assert.equal(store.snapshot().pausedVersion,null);
  manager.dispose();
});

test('a preference write failure is visible but still applies in memory',async t=>{
  const file=tempFile(t);
  const broken={...fs,openSync(value,...args){if(path.basename(value).endsWith('.tmp'))throw Error('disk full');return fs.openSync(value,...args);}};
  const store=createPreferenceStore({file,fsImpl:broken,randomId:()=> 'fixed'});
  const updater=makeUpdater();
  const manager=makeManager({t,updater,store,readUpdate:async()=>updatePayload({available:false,version:CURRENT})});
  const result=manager.setPreference('automatic');
  assert.equal(result.ok,true);
  assert.equal(result.persisted,false);
  assert.equal(manager.snapshot().preference,'automatic');
  assert.equal(manager.snapshot().preferenceSaveFailed,true);
  manager.dispose();
});
