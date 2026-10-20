const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let passed=0;async function check(name,run){await run();passed++;console.log('PASS '+name);}const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
 const {createRuntimeRegistry}=await import('../server/runtime-registry.js');
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-ordinary-runtime-'));const children=[];
 const workspace={projectId:'project',repoId:'repo',workspaceId:'project-project',workspaceEpoch:'epoch',cwd:world,root:world,branch:''};let shared=true;
 const registry=createRuntimeRegistry({dataDir:path.join(world,'data'),resolveWorkspace:async()=>workspace,validateWorkspace:async()=>{},sharedAdmission:async()=>{if(!shared)throw Object.assign(Error(),{code:'tool_guard_unavailable'});},
 factory:async(context,emit)=>{let disposed=false;const child={context,emit,commands:[],start(){emit({type:'bridge_status',state:'ready',bridgeRun:1});},request:async()=>({sessionId:context.sessionId||'native-new'}),getState:()=>({state:'ready'}),send(cmd){child.commands.push(cmd);},abortAndWait:async()=>({ok:true}),dispose:async()=>{disposed=true;},cleanupConfirmed:()=>disposed};children.push(child);return child;}});
 try{
  assert.equal(typeof registry.openProjectSession,'function','ordinary sessions require owner-scoped runtime binding');
  const a=await registry.openProjectSession({workspace,sessionId:'native-A',sessionLocator:null,sessionName:'A'});await tick();
  const b=await registry.openProjectSession({workspace,sessionId:'native-B',sessionLocator:null,sessionName:'B'});await tick();
  const ao=registry.getOwner(a.conversationId),bo=registry.getOwner(b.conversationId);
  await check('ordinary A/B get independent native sessions at the exact same cwd',()=>{assert.equal(children.length,2);assert.equal(children[0].context.cwd,children[1].context.cwd);assert.notEqual(ao.runtimeId,bo.runtimeId);assert.equal(ao.sessionId,'native-A');assert.equal(bo.sessionId,'native-B');});
  await check('opening the same native session twice returns its existing owner',async()=>{const again=await registry.openProjectSession({workspace,sessionId:'native-B',sessionLocator:null});assert.equal(again.conversationId,b.conversationId);assert.equal(children.length,2);});
  await check('two same-cwd tasks enter separate children; duplicate prompt remains blocked per session',async()=>{
   await registry.command(ao,{type:'prompt',message:'task A'});await registry.command(bo,{type:'prompt',message:'task B'});
   await assert.rejects(()=>registry.command(ao,{type:'prompt',message:'duplicate'}),e=>e.code==='runtime_busy');assert.equal(children[0].commands[0].message,'task A');assert.equal(children[1].commands[0].message,'task B');
  });
  await check('closing A retains B workspace occupancy and live control',async()=>{await registry.close(ao);assert.equal(registry.inUse(world),true);await registry.command(bo,{type:'abort'});assert.equal(registry.getOwner(b.conversationId).runtimeId,bo.runtimeId);});
  await registry.close(bo);
  await check('sharing requires guard admission, not a deleted lease check',async()=>{shared=false;await assert.rejects(()=>registry.openProjectSession({workspace,sessionId:'native-C'}),e=>e.code==='tool_guard_unavailable');assert.equal(children.length,2);});
  console.log(`Ordinary session runtime: ${passed}/${passed}`);
 }finally{await registry.dispose();fs.rmSync(world,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
