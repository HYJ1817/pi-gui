const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let passed=0;async function check(name,run){await run();passed++;console.log('PASS '+name);}const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
 const {createRuntimeRegistry}=await import('../server/runtime-registry.js');
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-ordinary-runtime-'));const children=[];const titleCalls=[];let nativeNameForGetState='';
 const workspace={projectId:'project',repoId:'repo',workspaceId:'project-project',workspaceEpoch:'epoch',cwd:world,root:world,branch:''};let shared=true;
 const registry=createRuntimeRegistry({dataDir:path.join(world,'data'),resolveWorkspace:async()=>workspace,validateWorkspace:async()=>{},sharedAdmission:async()=>{if(!shared)throw Object.assign(Error(),{code:'tool_guard_unavailable'});return ()=>shared;},
 sessionTitle:{resolve:(record,options)=>{titleCalls.push({name:record.sessionName||'',confirmed:options?.nativeConfirmed===true,source:record.nameSource});return {title:record.sessionName||'并行会话',source:'manual',revision:0};}},
 factory:async(context,emit)=>{let disposed=false;const child={context,emit,commands:[],start(){emit({type:'bridge_status',state:'ready',bridgeRun:1});},request:async()=>({sessionId:context.sessionId||'native-new',sessionName:nativeNameForGetState}),getState:()=>({state:'ready'}),send(cmd){child.commands.push(cmd);},abortAndWait:async()=>({ok:true}),dispose:async()=>{disposed=true;},cleanupConfirmed:()=>disposed};children.push(child);return child;}});
 try{
  assert.equal(typeof registry.openProjectSession,'function','ordinary sessions require owner-scoped runtime binding');
  const a=await registry.openProjectSession({workspace,sessionId:'native-A',sessionLocator:null,sessionName:'A'});await tick();
  const b=await registry.openProjectSession({workspace,sessionId:'native-B',sessionLocator:null,sessionName:'B'});await tick();
  const ao=registry.getOwner(a.conversationId),bo=registry.getOwner(b.conversationId);
  await check('opened-session display seed is not treated as a confirmed Pi native name',()=>{const call=titleCalls.find(c=>c.name==='A');assert.ok(call,'title resolution did not see the seeded record');assert.equal(call.confirmed,false);assert.equal(call.source,'seed');});
  await check('a get_state native name upgrades the record to confirmed',async()=>{nativeNameForGetState='Pi 原生 A';await registry.read(ao,{type:'get_state'});const call=titleCalls.filter(c=>c.name==='Pi 原生 A').at(-1);assert.ok(call,'title resolution did not see the confirmed native name');assert.equal(call.confirmed,true);assert.equal(call.source,'native');});
  await check('ordinary A/B get independent native sessions at the exact same cwd',()=>{assert.equal(children.length,2);assert.equal(children[0].context.cwd,children[1].context.cwd);assert.notEqual(ao.runtimeId,bo.runtimeId);assert.equal(ao.sessionId,'native-A');assert.equal(bo.sessionId,'native-B');});
  await check('opening the same native session twice returns its existing owner',async()=>{const again=await registry.openProjectSession({workspace,sessionId:'native-B',sessionLocator:null});assert.equal(again.conversationId,b.conversationId);assert.equal(children.length,2);});
  await check('two same-cwd tasks enter separate children; duplicate prompt remains blocked per session',async()=>{
   await registry.command(ao,{type:'prompt',message:'task A'});await registry.command(bo,{type:'prompt',message:'task B'});
   await assert.rejects(()=>registry.command(ao,{type:'prompt',message:'duplicate'}),e=>e.code==='runtime_busy');assert.equal(children[0].commands[0].message,'task A');assert.equal(children[1].commands[0].message,'task B');
  });
  await check('closing A retains B workspace occupancy and live control',async()=>{await registry.close(ao);assert.equal(registry.inUse(world),true);await registry.command(bo,{type:'abort'});assert.equal(registry.getOwner(b.conversationId).runtimeId,bo.runtimeId);});
  await registry.close(bo);
  await check('sharing requires guard admission, not a deleted lease check',async()=>{shared=false;await assert.rejects(()=>registry.openProjectSession({workspace,sessionId:'native-C'}),e=>e.code==='tool_guard_unavailable');assert.equal(children.length,2);});
  // Match production's split authority: initial worktree admission must never
  // resolve a project-* identity; only a stored project resume target may use
  // the ordinary resolver, which rechecks registration/epoch/native ownership.
  const {createOrdinarySessions,isProjectWorkspace}=await import('../server/ordinary-sessions.js');
  const cwd=path.join(world,'resume-project');fs.mkdirSync(cwd);
  const projects=[{path:cwd}],spawned=[];let primary=null,guard=true,maintenance=false,external=0,worktreeCalls=0,takeover=false,resuming;
  const ordinary=createOrdinarySessions({getProjects:()=>projects,resolveRoot:async p=>p,currentNative:async()=>primary});
  const resumeOptions={dataDir:path.join(world,'resume-data'),validateWorkspace:ordinary.validate,
   beforeStart:()=>maintenance?'maintenance':null,externalCount:()=>external,
   admission:(args,action,target)=>{
    if(target&&isProjectWorkspace(target.workspace))return ordinary.withResume(target,action);
    worktreeCalls++;throw Object.assign(Error('unknown_workspace'),{code:'unknown_workspace'});
   },sharedAdmission:async()=>{if(!guard)throw Object.assign(Error('tool_guard_unavailable'),{code:'tool_guard_unavailable'});if(takeover)primary='native-resume';return ()=>guard;},
   factory:async(context,emit)=>{let disposed=false;const child={context,start(){emit({type:'bridge_status',state:'ready',bridgeRun:1});},
    request:async()=>({sessionId:context.sessionId||'native-resume',sessionName:''}),getState:()=>({state:'ready'}),send(){},
    dispose:async()=>{disposed=true;},cleanupConfirmed:()=>disposed};spawned.push(child);return child;}};
  resuming=createRuntimeRegistry(resumeOptions);
  try{
   const w=await ordinary.workspaceFor(cwd),opened=await resuming.openProjectSession({workspace:w,sessionId:'native-resume'});await tick();
   const previous=resuming.getOwner(opened.conversationId);
   await check('project restart reuses ordinary authority and native session, not worktree admission',async()=>{
    const restarted=await resuming.restart(previous);await tick();const current=resuming.getOwner(opened.conversationId);
    assert.equal(restarted.ok,true);assert.equal(current.sessionId,previous.sessionId);assert.notEqual(current.runtimeId,previous.runtimeId);
    assert.notEqual(current.runtimeGeneration,previous.runtimeGeneration);assert.equal(worktreeCalls,0);assert.equal(spawned.length,2);
    await assert.rejects(()=>resuming.command(previous,{type:'get_state'}),e=>e.code==='stale_runtime');
   });
   await resuming.close(resuming.getOwner(opened.conversationId));
   await check('project resume refuses a native session now owned by Classic without spawning',async()=>{
    primary='native-resume';await assert.rejects(()=>resuming.resume(opened.conversationId),e=>e.code==='session_in_use');primary=null;
    assert.equal(spawned.length,2);assert.equal(resuming.liveCount(),0);
   });
   await check('unconfirmed Classic native identity cannot authorize a project resume',async()=>{
    primary=undefined;try{await assert.rejects(()=>resuming.resume(opened.conversationId),e=>e.code==='session_unavailable');assert.equal(spawned.length,2);}
    finally{primary=null;}
   });
   await check('project resume rechecks project registration before creating a replacement',async()=>{
    projects.length=0;await assert.rejects(()=>resuming.resume(opened.conversationId),e=>e.code==='unknown_project');projects.push({path:cwd});
    assert.equal(spawned.length,2);
   });
   await check('project resume rejects replacement directory epochs instead of rebinding',async()=>{
    fs.renameSync(cwd,cwd+'-old');fs.mkdirSync(cwd);
    try{await assert.rejects(()=>resuming.resume(opened.conversationId),e=>e.code==='stale_workspace');assert.equal(spawned.length,2);}
    finally{fs.rmdirSync(cwd);fs.renameSync(cwd+'-old',cwd);}
   });
   await check('project resume retains tool guard, maintenance and hard-budget gates',async()=>{
    guard=false;await assert.rejects(()=>resuming.resume(opened.conversationId),e=>e.code==='tool_guard_unavailable');guard=true;
    maintenance=true;await assert.rejects(()=>resuming.resume(opened.conversationId),e=>e.code==='maintenance');maintenance=false;
    external=3;await assert.rejects(()=>resuming.resume(opened.conversationId,{allowThird:true}),e=>e.code==='runtime_limit');external=0;
    assert.equal(spawned.length,2);
   });
   await check('Classic native takeover during shared admission is rechecked before child creation',async()=>{
    takeover=true;
    try{await assert.rejects(()=>resuming.resume(opened.conversationId),e=>e.code==='session_in_use');assert.equal(spawned.length,2);}
    finally{takeover=false;primary=null;}
   });
   await resuming.dispose();resuming=createRuntimeRegistry(resumeOptions);
   await check('backend restart keeps project dormant until explicitly resumed with fresh owner',async()=>{
    const snapshot=resuming.snapshot();assert.equal(snapshot.items.length,1);assert.equal(snapshot.items[0].owner,null);assert.equal(snapshot.liveCount,0);
    const restored=await resuming.resume(opened.conversationId);await tick();const current=resuming.getOwner(opened.conversationId);
    assert.equal(restored.ok,true);assert.equal(current.sessionId,previous.sessionId);assert.notEqual(current.backendInstance,previous.backendInstance);
    assert.equal(spawned.length,3);assert.equal(worktreeCalls,0);
   });
   await check('an unrelated missing registered project cannot block target project restoration',async()=>{
    await resuming.close(resuming.getOwner(opened.conversationId));projects.unshift({path:path.join(world,'offline-project')});
    const restored=await resuming.resume(opened.conversationId);await tick();assert.equal(restored.ok,true);
    assert.equal(resuming.getOwner(opened.conversationId).sessionId,previous.sessionId);assert.equal(spawned.length,4);
   });
  }finally{await resuming.dispose();}
  console.log(`Ordinary session runtime: ${passed}/${passed}`);
 }finally{await registry.dispose();fs.rmSync(world,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
