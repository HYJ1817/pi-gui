const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createAutoQuitCoordinator}=require('../electron/app-update-quit.cjs');

const flush=async()=>{for(let i=0;i<4;i+=1)await new Promise(resolve=>setImmediate(resolve));};
function quitEvent(){
  return {prevented:false,preventDefault(){this.prevented=true;}};
}
function setup({
  candidate={ok:true,version:'0.35.0'},
  preflight={ok:true},
  installResult={ok:true},
  recovering=false,
  suppressed=false,
  shutdown=false,
  authorize=null,
  onInstall=null,
}={}){
  const calls={install:0,quit:0,preflight:0};
  let coordinator;
  coordinator=createAutoQuitCoordinator({
    manager:{autoInstallCandidate:()=>{
      calls.candidate=(calls.candidate||0)+1;
      return typeof candidate==='function'?candidate():candidate;
    }},
    install:async options=>{
      calls.install+=1;
      calls.installOptions=options;
      if(onInstall)await onInstall(coordinator,options);
      return typeof installResult==='function'?installResult():installResult;
    },
    authorize:authorize||undefined,
    preflight:async()=>{
      calls.preflight+=1;
      return typeof preflight==='function'?preflight():preflight;
    },
    quit:()=>{calls.quit+=1;},
    isRecovering:()=>typeof recovering==='function'?recovering():recovering,
    isSuppressed:()=>typeof suppressed==='function'?suppressed():suppressed,
    isSystemShutdown:()=>typeof shutdown==='function'?shutdown():shutdown,
  });
  return {coordinator,calls};
}

test('manual or no-ready states fall through to a normal quit without preflight',async()=>{
  for(const candidate of [
    {ok:false,code:'preference'},
    {ok:false,code:'not-ready'},
    {ok:false,code:'ignored'},
    {ok:false,code:'paused'},
    {ok:false,code:'blocked'},
  ]){
    const {coordinator,calls}=setup({candidate});
    const event=quitEvent();
    assert.equal(coordinator.beforeQuit(event),false,candidate.code);
    assert.equal(event.prevented,false,candidate.code);
    await flush();
    assert.equal(calls.preflight,0);
    assert.equal(calls.install,0);
    assert.equal(calls.quit,0);
  }
});

test('automatic ready performs preflight, installs once and allows the real quit',async()=>{
  const event=quitEvent();
  const {coordinator,calls}=setup({onInstall:async self=>self.markQuitIssued()});
  assert.equal(coordinator.beforeQuit(event),true);
  assert.equal(event.prevented,true);
  assert.equal(coordinator.canQuit(),false,'window close must wait for the preflight');
  await flush();
  assert.equal(calls.candidate,2,'eligibility is recomputed after the async preflight');
  assert.equal(calls.preflight,1);
  assert.equal(calls.install,1);
  assert.equal(coordinator.canQuit(),true,'the helper-triggered quit must be allowed');
  assert.equal(coordinator.beforeQuit(quitEvent()),false);
  assert.equal(calls.install,1,'a second quit event cannot install twice');
});

test('a window close is deferred only while an eligible auto install can still start',async()=>{
  const {coordinator,calls}=setup();
  assert.equal(coordinator.shouldDeferClose(),true);
  const event=quitEvent();
  assert.equal(coordinator.beforeQuit(event),true);
  assert.equal(coordinator.shouldDeferClose(),false,'once preflight owns the quit, close is handled by canQuit');
  await flush();
  assert.equal(calls.install,1);
  assert.equal(coordinator.shouldDeferClose(),false);

  assert.equal(setup({candidate:{ok:false,code:'preference'}}).coordinator.shouldDeferClose(),false);
  assert.equal(setup({shutdown:true}).coordinator.shouldDeferClose(),false);
  assert.equal(setup({suppressed:true}).coordinator.shouldDeferClose(),false);
  assert.equal(setup({recovering:true}).coordinator.shouldDeferClose(),false);
});

test('auto install passes a live authorization check into the updater',async()=>{
  let eligible=true,seen=null;
  const {coordinator,calls}=setup({
    authorize:()=>eligible,
    onInstall:async(self,options)=>{
      assert.equal(typeof options.authorize,'function');
      eligible=false;
      seen=options.authorize();
      self.markQuitIssued();
    },
  });
  const event=quitEvent();
  assert.equal(coordinator.beforeQuit(event),true);
  await flush();
  assert.equal(seen,false,'the updater must be able to revoke an install after it starts');
  assert.equal(calls.install,1);
});

test('system shutdown during preflight stops blocking the quit and never installs',async()=>{
  let release,shutdown=false;
  const gate=new Promise(resolve=>{release=resolve;});
  const {coordinator,calls}=setup({preflight:()=>gate.then(()=>({ok:true})),shutdown:()=>shutdown});
  const event=quitEvent();
  assert.equal(coordinator.beforeQuit(event),true);
  shutdown=true;
  const shutdownEvent=quitEvent();
  assert.equal(coordinator.beforeQuit(shutdownEvent),false,'shutdown must not wait for the preflight');
  assert.equal(shutdownEvent.prevented,false);
  release();
  await flush();
  assert.equal(calls.install,0);
  assert.equal(calls.preflight,1);
});

test('a busy preflight abandons auto-install and resumes normal quit',async()=>{
  const event=quitEvent();
  const {coordinator,calls}=setup({preflight:{ok:false,code:'busy'}});
  assert.equal(coordinator.beforeQuit(event),true);
  await flush();
  assert.equal(calls.preflight,1);
  assert.equal(calls.install,0);
  assert.equal(calls.quit,1);
  assert.equal(coordinator.canQuit(),true);
  assert.equal(coordinator.beforeQuit(quitEvent()),false,'the fallback quit must not loop');
});

test('state changes during preflight revoke the earlier candidate',async()=>{
  let eligible=true;
  const event=quitEvent();
  const {coordinator,calls}=setup({
    candidate:()=>eligible?{ok:true,version:'0.35.0'}:{ok:false,code:'ignored'},
    onInstall:async self=>self.markQuitIssued(),
  });
  assert.equal(coordinator.beforeQuit(event),true);
  eligible=false;
  await flush();
  assert.equal(calls.preflight,1);
  assert.equal(calls.install,0,'a stale preflight result is not a permanent install permit');
  assert.equal(calls.quit,1);
});

test('install failure releases the flow and falls back to normal quit',async()=>{
  const event=quitEvent();
  const {coordinator,calls}=setup({installResult:{ok:false,code:'helper_unavailable'}});
  assert.equal(coordinator.beforeQuit(event),true);
  await flush();
  assert.equal(calls.install,1);
  assert.equal(calls.quit,1);
  assert.equal(coordinator.canQuit(),true);
  assert.equal(coordinator.beforeQuit(quitEvent()),false);
});

test('system shutdown and recovery suppression never attempt auto install',async()=>{
  for(const options of [{shutdown:true},{suppressed:true}]){
    const event=quitEvent();
    const {coordinator,calls}=setup(options);
    assert.equal(coordinator.beforeQuit(event),false);
    assert.equal(event.prevented,false);
    await flush();
    assert.equal(calls.preflight,0);
    assert.equal(calls.install,0);
    assert.equal(calls.quit,0);
  }
});

test('recovery in progress blocks quit without starting auto install',async()=>{
  const event=quitEvent();
  const {coordinator,calls}=setup({recovering:true});
  assert.equal(coordinator.beforeQuit(event),true);
  assert.equal(event.prevented,true);
  await flush();
  assert.equal(calls.preflight,0);
  assert.equal(calls.install,0);
  assert.equal(coordinator.canQuit(),false);
});

test('repeated quit events during preflight cannot start a second attempt',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const event=quitEvent();
  const {coordinator,calls}=setup({preflight:()=>gate.then(()=>({ok:false}))});
  assert.equal(coordinator.beforeQuit(event),true);
  assert.equal(coordinator.beforeQuit(quitEvent()),true);
  assert.equal(coordinator.beforeQuit(quitEvent()),true);
  assert.equal(calls.preflight,1);
  release();
  await flush();
  assert.equal(calls.preflight,1);
  assert.equal(calls.install,0);
  assert.equal(calls.quit,1);
});

test('explicit install blocks a concurrent auto attempt and quit until armed',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const {coordinator,calls}=setup({
    installResult:{ok:true},
    onInstall:async self=>{await gate;self.markQuitIssued();},
  });
  const pending=coordinator.runExplicitInstall();
  assert.equal(coordinator.canQuit(),false);
  assert.equal(coordinator.beforeQuit(quitEvent()),true);
  const second=await coordinator.runExplicitInstall();
  assert.equal(second.code,'busy');
  release();
  await pending;
  assert.equal(calls.install,1);
  assert.equal(coordinator.canQuit(),true);
});

test('explicit install failure leaves the app open and auto quit available later',async()=>{
  const {coordinator,calls}=setup({installResult:{ok:false,code:'cancelled'}});
  const result=await coordinator.runExplicitInstall();
  assert.equal(result.ok,false);
  assert.equal(coordinator.canQuit(),true);
  const event=quitEvent();
  assert.equal(coordinator.beforeQuit(event),true,'a later normal quit may still auto install');
  await flush();
  assert.equal(calls.preflight,1);
});
