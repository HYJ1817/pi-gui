// Test-only TEMP issuer. All roots/materials are created here, never by renderer.
import assert from 'node:assert/strict';
import {awaitVerifiedNativeOwner} from './session-revert-object-session-binding.mjs';
import {saveInitialSnapshot,compareFinalSnapshot,createCleanup,preserveFailure,verifyTransactions} from './session-revert-object-d6final-checks.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {Readable,PassThrough} from 'node:stream';
import {createSessionChangeStore} from '../../server/session-change-store.js';
import {createSessionChangeBridge} from '../../server/session-change-bridge.js';
import {createPiLaunch} from '../../server/pi-launch.js';
import {observeFileObject} from '../../server/session-revert-object-observer.js';
import {inspectFileMetadata} from '../../server/session-revert-metadata.js';
import {createSessionRevertRoutes} from '../../server/session-revert-routes.js';
import {runSessionRevert} from '../../server/session-revert-compute.js';
import {createSessionRevertAdmission} from '../../server/session-revert-admission.js';
import {createSessionRevertMutationAuthority} from '../../server/session-revert-authority.js';
import {createObjectServiceCore} from '../../server/session-revert-object-service.js';
import {createIsolatedWriter} from '../../server/session-revert-object-writer.js';
import {evaluateObjectProfile,READONLY_OBJECT_PROOF,objectScopeBinding} from '../../server/session-revert-object-profile.js';
import {OBJECT_HELPER_HASH} from '../../server/session-revert-object-source.js';
import {OBJECT_WRITER_HASH,OBJECT_RISK_VERSION,objectFileId,sameObjectScope} from '../../server/session-revert-object-contract.js';
import {readAsset,hasBundledAssets,materializeDir} from '../../lib/assets.js';
import {projectObjectPlan,projectObjectResult,projectObjectHistory} from '../../server/session-revert-object-presentation.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',windowsHide:true,stdio:'pipe'}).trim();
const closed=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).every(k=>keys.includes(k));
const wait=async(fn,timeout=120000)=>{const end=Date.now()+timeout;while(!await fn()){if(Date.now()>end)fail('fixture_timeout');await new Promise(r=>setTimeout(r,35));}};
function pipeFault(measure){return (...args)=>{
 const child=spawn(...args),output=new PassThrough();let buffer='';
 child.stdout.on('data',b=>{buffer+=b.toString();while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);const row=JSON.parse(line);if(row.phase==='result'&&row.status==='verified'){measure.actualNativeVerified++;output.write('{D5 injected uncertain response}\n');}else output.write(line+'\n');}});
 child.stdout.on('end',()=>output.end());
 return new Proxy(child,{get(t,k){if(k==='stdout')return output;const v=Reflect.get(t,k,t);return typeof v==='function'?v.bind(t):v;}});
};}
import {createWorktrees} from '../../server/worktrees.js';
import {createRuntimeRegistry} from '../../server/runtime-registry.js';
import {createSessionRuntime} from '../../server/session-runtime.js';
import {createRuntime} from '../../server/runtime.js';
import {createSessionRevertAuthority} from '../../server/session-revert-authority.js';
import {createSessionRevertObjectRuntimeAuthority,createSessionRevertStopAndDrain} from '../../server/session-revert-object-runtime-authority.js';

// Creation performs offline runtime/capture initialization only. The root runner
// explicitly calls capture() after installing the shared non-refundable budget.
// Neither creation nor preflight sends a model prompt.
export async function createD6ModelFixture({rpcLauncher,mode='classic',modelConfig,permitRequest,fault=false,promptTimeoutMs=120000,preflightOnly=false}={}){
 assert.ok(['classic','managed'].includes(mode));
 assert.equal(typeof permitRequest,'function');assert.equal(typeof modelConfig?.apiKey,'string');
 assert.ok(modelConfig.apiKey);assert.equal(modelConfig.defaultProvider,'deepseek');assert.equal(modelConfig.defaultModel,'deepseek-flash');
 assert.equal(modelConfig.model?.provider,modelConfig.defaultProvider);assert.equal(modelConfig.model?.id,modelConfig.defaultModel);
 assert.equal(OBJECT_RISK_VERSION,3);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'p33-D6-model-')),repo=path.join(root,'repo'),dataDir=path.join(root,'private-data'),agentDir=path.join(root,'agent'),sessions=path.join(root,'sessions');
 for(const dir of [repo,dataDir,agentDir,sessions])await fs.mkdir(dir);
 const B=Buffer.from('user preexisting\nanchor-one\nbody\nanchor-two\ntail\n'),C=Buffer.from('agent-one\nanchor-one\nagent-two\nanchor-two\nuser later\n'),R=Buffer.from('user preexisting\nanchor-one\nbody\nanchor-two\nuser later\n');
 await fs.writeFile(path.join(repo,'file.txt'),B);
 git(repo,'init','--quiet');git(repo,'config','core.autocrlf','false');git(repo,'add','file.txt');git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','D6 TEMP fixture');
 let active=true,service,registry,worktrees,adapter,scope,owner,workspace=repo,nativeSessionId=null,resourceBinding,settled=0;
 const children=[],attempts=[],plans=new Map(),cap=Object.freeze({}),storeCaps=new WeakSet([cap]),nativeCaps=new WeakSet();
 const measure={root,mode,guardianTransport:'test-ipc-supervisor',runtimeAuthority:'real-registry-session-runtime',commits:0,opens:0,stops:0,rpcTools:[],actualNativeVerified:0,fault,sourceVerified:false,modelRequests:0,piVersion:null};
 const store=await createSessionChangeStore({dataDir,objectPlanAuthority:(s,_id,c)=>active&&storeCaps.has(c)&&scope&&sameObjectScope(scope,s)});
 const admission=createSessionRevertAdmission(),extensionFile=path.join(materializeDir('extensions/pi-gui-revert'),'index.js');
 const launch=createPiLaunch(),packageDir=launch.packageDir(),entry=launch.cliEntry();assert.ok(packageDir&&entry?.ok);
 assert.equal(path.resolve(packageDir),path.resolve(modelConfig.packageDir));
 measure.piVersion=JSON.parse(await fs.readFile(path.join(packageDir,'package.json'),'utf8')).version;
 const runtime=createRuntime({initialCwd:repo});
 const classicOwner=()=>{const state=adapter?.getState()??{};const id=hash(repo.toLowerCase());return {backendInstance:registry.snapshot().backendInstance,projectId:id,repoId:null,workspaceId:id,workspaceEpoch:String(runtime.getWorkspaceGeneration()),conversationId:'classic-chat',runtimeId:state.bridgeInstance,runtimeGeneration:String(state.bridgeRun),sessionId:nativeSessionId};};
 const event=ev=>{if(ev.type==='agent_settled')settled++;if(ev.type==='tool_execution_end')measure.rpcTools.push({toolName:ev.toolName,toolCallId:ev.toolCallId,isError:ev.isError});if(mode==='classic'&&ev.type==='bridge_status'&&ev.state!=='ready')nativeSessionId=null;};
 // The private transport keeps production Runtime/Registry identity semantics.
 // It uses IPC instead of the production guardian: no guardian evidence claimed.
 const supervisorFactory=()=>({
  spawnProcess(_command,args,opts){
   if(!active)fail('stale_runtime');
   const child=spawn(process.execPath,[rpcLauncher,...args.slice(1)],{...opts,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe','ipc']});children.push(child);
   child.on('message',async row=>{
    if(row?.type==='d6-model-permit'){
     let grant={allowed:false,totalReserved:8};
     try{if(row.projectId!==currentProjectId()||!Number.isInteger(row.projectRequest)||row.projectRequest<1||row.projectRequest>4)fail('model_budget_refused');grant=await permitRequest({requestId:row.requestId,projectId:row.projectId,projectRequest:row.projectRequest});}catch{}
     if(child.connected)child.send({type:'d6-model-permit-result',requestId:row.requestId,...grant});
    }else if(row?.type==='d6-model-count'){measure.modelRequests=row.projectRequests;}
    else if(row?.type==='d6-ready'){measure.model={provider:row.provider,id:row.model,api:row.api};measure.sdkSessionId=row.sessionId;}
   });
   child.once('spawn',()=>child.send({type:'d6-init',...modelConfig,workspace,agentDir,sessionDir:sessions,extensionFile,projectId:currentProjectId()}));
   return child;
  },
  async killProcessTree(child){if(!children.includes(child))fail('foreign_process');if(child.exitCode!==null)return;await new Promise(resolve=>{child.once('close',resolve);child.kill();});},
  async dispose(){await Promise.all(children.map(async child=>{if(child.exitCode===null)await new Promise(resolve=>{child.once('close',resolve);child.kill();});}));},
 });
 const currentProjectId=()=>mode==='classic'?classicOwner().projectId:managedContext.workspace.projectId;
 let managedContext=null;
 const createAdapter=async(context,emit)=>createSessionRuntime({context,emit:ev=>{event(ev);emit(ev);},piBin:entry.entryPath,dataDir,sessionDir:sessions,env:{...process.env,PI_NO_CONTINUE:'1'},supervisorFactory,mutationAdmission:admission,
  createChanges:({launch:actualLaunch,requestState})=>createSessionChangeBridge({store,launch:actualLaunch,admission,extensionPath:extensionFile,inspectFileMetadata,inspectObjectEvidence:observeFileObject,
   resolveScope:async()=>{let actual;if(mode==='classic'){const state=await requestState();if(!state?.sessionId||state.__error)fail('stale_runtime');nativeSessionId=state.sessionId;actual=classicOwner();}else actual=await awaitVerifiedNativeOwner({context,requestState,isReady:()=>adapter?.getState().bridgeState==='ready'&&registry.snapshot().items.some(i=>i.conversationId===context.getOwner().conversationId&&i.lifecycle==='ready')});return {runtimeOwner:actual,projectId:actual.projectId,repoId:actual.repoId,conversationId:actual.conversationId,nativeSessionId:actual.sessionId,workspaceId:actual.workspaceId,workspaceEpoch:actual.workspaceEpoch};},
   withAuthority:fn=>mode==='classic'?worktrees.withActivation(repo,()=>fn({root:repo})):worktrees.withWorkspace({id:context.workspace.workspaceId,epoch:context.workspace.workspaceEpoch},fn),
  })});
 worktrees=createWorktrees({dataDir,getProjects:()=>[{path:repo,name:'D6 TEMP model'}],getContext:()=>({cwd:repo,generation:1}),isWorkspaceInUse:p=>registry?.inUse(p)||false});
 registry=createRuntimeRegistry({dataDir,admission:(args,fn)=>worktrees.withWorkspace(args,fn),validateWorkspace:w=>worktrees.withWorkspace({id:w.workspaceId,epoch:w.workspaceEpoch},()=>{}),factory:async(context,emit)=>{managedContext=context;return adapter=await createAdapter(context,emit);}});
 let withAuthority,bridge,target,gitBefore;
 const snapshotFile=path.join(root,'git-initial-snapshot.json');
 const cleanupState=createCleanup([
  ['deactivate',()=>{active=false;}],['service',()=>service?.dispose()],
  ['attempts',async()=>{const results=await Promise.allSettled(attempts.map(a=>a.close()));const failed=results.filter(r=>r.status==='rejected');if(failed.length)throw new AggregateError(failed.map(r=>r.reason));}],
  ['binding',()=>resourceBinding?.dispose()],['registry',()=>registry?.dispose()],
  ['adapter',()=>adapter?.dispose()],['worktrees',()=>worktrees?.dispose()]
 ]);
 async function cleanup(){measure.cleanup=await cleanupState.run();return measure.cleanup;}

 try{
  if(mode==='managed'){
   const w=(await worktrees.create({nonce:(await worktrees.prepare({project:repo,branch:'codex/d6-real-model'})).nonce})).workspace;workspace=w.path;
   const started=await registry.start({id:w.id,epoch:w.epoch});
   await wait(()=>registry.snapshot().items.some(i=>i.conversationId===started.conversationId&&i.lifecycle==='ready'&&i.owner?.sessionId),promptTimeoutMs);
   owner=registry.getOwner(started.conversationId);await registry.focus(owner);
  }else{
   const context={cwd:repo,workspace:{root:repo},sessionId:null,isCurrent:()=>active,getOwner:classicOwner};
   adapter=await createAdapter(context,()=>{});adapter.start();await wait(()=>adapter.getState().bridgeState==='ready',promptTimeoutMs);
   nativeSessionId=(await adapter.request({type:'get_state'})).sessionId;owner=classicOwner();
  }
  bridge=adapter.changes;
  await wait(async()=>{const s=await bridge.summary();return s.sourceVerified;},promptTimeoutMs);measure.sourceVerified=true;
  withAuthority=createSessionRevertObjectRuntimeAuthority({withAuthority:createSessionRevertAuthority({registry,worktrees,classicBridge:bridge,classicOwner,classicNativeState:()=>adapter.request({type:'get_state'}),classicBusy:()=>adapter.activity.busy()}),registry,classicCurrent:()=>mode==='classic'?{owner:classicOwner(),ready:active&&adapter.getState().bridgeState==='ready'}:null});
  const resolved=await withAuthority({}, {owner,conversationId:owner.conversationId},a=>({scope:a.scope,root:a.root}));scope=resolved.scope;assert.equal(resolved.root,workspace);assert.equal(scope.runtimeOwner.sessionId,measure.sdkSessionId);
  target=path.join(workspace,'file.txt');gitBefore=await saveInitialSnapshot(snapshotFile,{repo,workspace,target,owner,scope});measure.gitInitialSnapshot=snapshotFile;
  // Configure through the existing authenticated extension transport. The bridge
  // already prepared its own launch env; credentials never enter that channel.
  const prepared=await bridge.captureStatus(scope);assert.equal(prepared.sourceVerified,true);
  await store.configure(scope,{enabled:true,acknowledged:true,exclusions:[]});
  if(preflightOnly)return {root,owner,scope,measure,preflightOnly:true,async dispose(){return cleanup();}};
 }catch(error){return preserveFailure(error,cleanupState);}
 let captureStarted=false;
 async function capture(){
  if(captureStarted||!active)fail('model_capture_already_started');captureStarted=true;
  try{
  const prompts=[
   'Use the write tool exactly once on relative path file.txt with this exact UTF-8 content, preserving final newline: '+JSON.stringify('agent-one\nanchor-one\nbody\nanchor-two\ntail\n')+'. Do not call any other tool. Then respond briefly.',
   'Use the edit tool exactly once on relative path file.txt to replace the unique text body with agent-two. Change nothing else. Do not call any other tool. Then respond briefly.'
  ];
  for(const prompt of prompts){const prior=settled;if(mode==='managed')await registry.command(owner,{type:'prompt',message:prompt});else await adapter.send({type:'prompt',message:prompt});await wait(()=>settled>prior,promptTimeoutMs);}
  const summary=await store.summary(scope);assert.equal(summary.operationCount,2);
  for(const row of summary.operations){const r=await store.read(scope,row.operationId);assert.equal(r.evidenceLevel,'intent_verified');assert.equal(r.objectEvidenceVersion,1);assert.equal(r.toolResultObserved,true);assert.equal(r.beforeObjectEvidence.status,'observed');assert.equal(r.afterObjectEvidence.status,'observed');assert.deepEqual(r.scope.runtimeOwner,owner);}
  assert.deepEqual(measure.rpcTools.map(r=>r.toolName),['write','edit']);assert.equal(measure.rpcTools.some(r=>r.isError),false);
  assert.deepEqual(await fs.readFile(target),Buffer.from('agent-one\nanchor-one\nagent-two\nanchor-two\ntail\n'));
  await fs.writeFile(target,C);
 }catch(error){return preserveFailure(error,cleanupState);}
 const stop=createSessionRevertStopAndDrain({admission,registry,worktrees,classic:{root:()=>mode==='classic'?workspace:null,manager:adapter.managed.manager,abort:command=>adapter.abortAndWait(command)}});
 const withMutationAuthority=createSessionRevertMutationAuthority({withAuthority,admission,stopAndDrain:async target=>{measure.stops++;await stop(target);}});
 const helperBytes=readAsset(hasBundledAssets()?'revert-object/write.ps1':'server/session-revert-object-write-native.ps1');assert.equal(hash(helperBytes),OBJECT_WRITER_HASH);
 let faultPending=fault===true?1:Number(fault)||0;
 const makeWriter=uncertain=>createIsolatedWriter({owns:a=>active&&nativeCaps.has(a)&&resourceBinding?.isCurrent(),helperBytes,materials:async(a,c,r)=>{assert.equal(nativeCaps.has(a),true);return [await store.restoreDescriptor(scope,c),await store.restoreDescriptor(scope,r)];},admit:o=>{assert.equal(o.status,'observed');assert.equal(o.binding.scope,objectScopeBinding(scope));assert.equal(o.file.links,1);assert.equal(o.file.reparse,false);assert.equal(o.file.encoding,'utf8');assert.deepEqual(o.streams.names,['::$DATA']);assert.equal(o.ea.bytes,0);for(const k of ['owner','group','dacl'])assert.equal(o.security[k].state,'known');},...(uncertain?{spawnProcess:pipeFault(measure)}:{})});
 service=createObjectServiceCore({store,withAuthority,withMutationAuthority,capability:cap,qualify:async()=>({proofId:'p33-d2-isolated',helperHash:OBJECT_WRITER_HASH}),openAttempt:async args=>{assert.equal(args.authority.root,workspace);const a=Object.freeze({...args.authority});nativeCaps.add(a);const w=makeWriter(faultPending>0);faultPending=Math.max(0,faultPending-1);const attempt=await w({...args,authority:a});attempts.push(attempt);measure.opens++;return {...attempt,commit:async v=>{measure.commits++;return attempt.commit(v);}};}});
 resourceBinding=mode==='managed'?registry.bindResource(owner,{dispose:()=>service.dispose()}):{isCurrent:()=>active&&JSON.stringify(classicOwner())===JSON.stringify(owner),dispose:async()=>service.dispose()};
 const routes=createSessionRevertRoutes({store,withAuthority});
 async function readonly(name,body){const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST';req.url='/api/session-revert/'+name;let result;const res={writeHead(){return this;},end(bytes){result=JSON.parse(Buffer.from(bytes).toString());}};await routes.handle(req,res);return result;}
 function identity(body){if(!closed(body,['conversationId','owner','evidenceIds','evidenceRevision','fileId','providerId','objectId','riskNoticeVersion','planId','requestId','confirmation','sourcePlanId','material','limit','cursor','mode','includeDiff']))fail('invalid_request');if(body.owner&&JSON.stringify(body.owner)!==JSON.stringify(owner)||body.conversationId&&body.conversationId!==owner.conversationId)fail('stale_runtime');}
 async function planProjection(raw){const p=await store.objectGet(scope,raw.planId,{capability:cap});plans.set(raw.planId,{raw,p,expectedCurrent:await fs.readFile(target)});return projectObjectPlan(raw);}
 const binding=body=>{const cached=plans.get(body.planId);if(!cached)fail('confirmation_required');const f=cached.p.files[0];if(body.riskNoticeVersion!==3||body.providerId!==cached.p.providerId||body.fileId!==f.fileId||body.objectId!==f.currentObject.file.id)fail('confirmation_required');return cached;};
 async function lineage(planId){let current=await store.objectGet(scope,planId,{capability:cap}),p=current;const seen=new Set();for(let n=0;n<16;n++){if(!p||seen.has(p.planId)||!sameObjectScope(p.scope,scope)||p.files[0].fileId!==current.files[0].fileId||p.files[0].currentObject.file.id!==current.files[0].currentObject.file.id)fail('recovery_unavailable');seen.add(p.planId);await service.inspectObjectRecovery({}, {owner,conversationId:owner.conversationId,planId:p.planId});if(p.kind==='revert')return {current,original:p};p=await store.objectGet(scope,p.sourcePlanId,{capability:cap});}fail('recovery_unavailable');}
 const identityKeys=['conversationId','owner'],selectedKeys=[...identityKeys,'evidenceIds','evidenceRevision'],bindingKeys=['providerId','fileId','objectId','riskNoticeVersion'];
 const schemas={query:[...identityKeys,'limit','cursor'],preview:[...selectedKeys,'mode','includeDiff'],history:identityKeys,qualification:selectedKeys,prepare:[...selectedKeys,...bindingKeys],apply:[...identityKeys,...bindingKeys,'planId','requestId','confirmation'],cancel:[...identityKeys,...bindingKeys,'planId'],inspectRecovery:[...identityKeys,...bindingKeys,'sourcePlanId'],prepareRecovery:[...identityKeys,...bindingKeys,'sourcePlanId','evidenceRevision'],exportMaterial:[...identityKeys,...bindingKeys,'sourcePlanId','material']};
 async function invoke(method,body){try{
  if(!schemas[method]||!closed(body,schemas[method]))fail('invalid_request');
  identity(body);
  if(['query','preview'].includes(method))return readonly(method,body);
  if(method==='history'){const rows=[];for(const [id,{p}] of plans){const current=await store.objectGet(scope,id,{capability:cap});if(current.state!=='recovery_required')continue;const inspected=await service.inspectObjectRecovery({}, {owner,conversationId:owner.conversationId,planId:id});rows.push({...projectObjectHistory(current),backupReady:true,recoveryEligible:inspected.recoveryAvailable,objectId:p.files[0].currentObject.file.id});}return {ok:true,plans:rows};}
  if(method==='qualification'){
   const snap=await store.previewSnapshot(scope,{evidenceIds:body.evidenceIds,maxOperations:128});if(snap.revision!==body.evidenceRevision||snap.gapRevision!==0)fail('stale_evidence');assert.equal(snap.records.length,2);const observation=await observeFileObject({root:workspace,relativePath:'file.txt',scope,operationId:snap.records[0].operationId});
   for(const r of snap.records){const profile=evaluateObjectProfile({evidence:r,current:{bytes:await fs.readFile(target),observation:{...observation,binding:{...observation.binding,operationId:r.operationId}},scope,gapRevision:0},platformProof:READONLY_OBJECT_PROOF,helperHash:OBJECT_HELPER_HASH});if(profile.qualification.reason!=='production_allowlist_empty')fail(profile.qualification.reason);}
   const candidate=await runSessionRevert({records:snap.records,selectedOperationIds:body.evidenceIds,current:await fs.readFile(target),gapRevision:0});if(candidate.status!=='candidate'||!candidate.contentEligible)fail(candidate.reason??'incomplete_evidence');
   return {ok:true,eligible:true,providerId:'windows-original-object-v1',riskNoticeVersion:3,fileId:objectFileId(scope,'file.txt'),objectId:observation.file.id};
  }
  if(method==='prepare'){if(body.riskNoticeVersion!==3||body.providerId!=='windows-original-object-v1'||body.fileId!==objectFileId(scope,'file.txt'))fail('invalid_selection');const o=await observeFileObject({root:workspace,relativePath:'file.txt',scope,operationId:'d5-current'});if(o.file.id!==body.objectId)fail('object_identity_changed');return await planProjection(await service.prepareObjectRevert({}, {owner,conversationId:owner.conversationId,evidenceIds:body.evidenceIds,fileId:body.fileId,evidenceRevision:body.evidenceRevision}));}
  if(method==='apply'){const {raw}=binding(body);return projectObjectResult(await service.applyObjectRevert({}, {owner,conversationId:owner.conversationId,providerId:raw.providerId,profileId:raw.profileId,helperHash:raw.helperHash,proofId:raw.proofId,planId:body.planId,confirmationToken:raw.confirmationToken,requestId:body.requestId,riskNoticeVersion:body.riskNoticeVersion,confirmation:body.confirmation}));}
  if(method==='cancel'){binding(body);return projectObjectResult(await service.cancelObjectRevert({}, {owner,conversationId:owner.conversationId,planId:body.planId}));}
  if(method==='inspectRecovery'){binding({...body,planId:body.sourcePlanId});const line=await lineage(body.sourcePlanId),v=await service.inspectObjectRecovery({}, {owner,conversationId:owner.conversationId,planId:body.sourcePlanId});return {...projectObjectResult(v),ok:true,revision:v.revision,backupReady:true,materialAvailable:true,availableMaterials:line.current.kind==='recover'?['C','R','D']:['C','R'],recoveryEligible:v.recoveryAvailable};}
  if(method==='prepareRecovery'){binding({...body,planId:body.sourcePlanId});return await planProjection(await service.prepareObjectRecovery({}, {owner,conversationId:owner.conversationId,sourcePlanId:body.sourcePlanId,evidenceRevision:body.evidenceRevision}));}
  if(method==='exportMaterial'){binding({...body,planId:body.sourcePlanId});if(!['C','R','D'].includes(body.material))fail('invalid_request');const line=await lineage(body.sourcePlanId);if(body.material==='D'&&line.current.kind!=='recover')fail('material_unavailable');const v=await service.exportVerifiedRecoveryMaterial({}, {owner,conversationId:owner.conversationId,planId:body.material==='D'?line.current.planId:line.original.planId,material:body.material==='R'?'candidate':'current'});return {ok:true,verified:true,bytes:Array.from(v.bytes),material:body.material};}
  fail('invalid_request');
 }catch(e){return {ok:false,code:e.code??'fixture_request_refused',needsRepreview:['stale_current','stale_runtime','stale_evidence','plan_expired'].includes(e.code)};}}
 async function verify(){
  const saved=[];for(const id of plans.keys()){const p=await store.objectGet(scope,id,{capability:cap}),f=p.files[0],actualCurrent=await store.restoreRead(scope,f.currentRef),actualCandidate=await store.restoreRead(scope,f.candidateRef);assert.equal(hash(actualCurrent),f.currentRef.digest);assert.equal(hash(actualCandidate),f.candidateRef.digest);if(p.kind==='revert'){assert.deepEqual(actualCurrent,C);assert.deepEqual(actualCandidate,R);}else{assert.deepEqual(actualCandidate,C);assert.deepEqual(actualCurrent,plans.get(id).expectedCurrent);}if(p.state==='applied_verified')assert.equal(f.verifiedMeasurement.id,f.currentObject.file.id);saved.push({planId:id,kind:p.kind,state:p.state,sourcePlanId:p.sourcePlanId??null,requestId:p.requestId??null,attemptId:f.intent?.attemptId??null,intentRequestId:f.intent?.requestId??null,readyDigest:f.intent?.readyDigest??null,readyObjectId:f.intent?.readyObjectId??null,bindingDigest:f.intent?.bindingDigest??null,currentDigest:f.currentRef.digest,candidateDigest:f.candidateRef.digest,materialBytesExact:true,measuredCurrentDigest:hash(plans.get(id).expectedCurrent),objectId:f.currentObject.file.id,verifiedObjectId:f.verifiedMeasurement?.id??null,metadataEqual:f.verifiedMeasurement?.metadataEqual??null});}
  const current=await withAuthority({}, {owner,conversationId:owner.conversationId},async a=>{await a.revalidate();return {root:a.root,scope:a.scope};});
  assert.equal(current.root,workspace);
  const currentOwner=mode==='classic'?classicOwner():registry.getOwner(owner.conversationId);
  const snapshot=await compareFinalSnapshot(snapshotFile,{repo,workspace,owner:currentOwner,scope:current.scope});
  const D=hash(plans.get(saved.find(p=>p.kind==='recover')?.planId)?.expectedCurrent??Buffer.alloc(0));
  const transactions=verifyTransactions(saved,{C:hash(C),R:hash(R),D,commits:measure.commits,opens:measure.opens});
  assert.deepEqual(await fs.readFile(target),C);
  return {...measure,scope,saved,finalDigest:hash(await fs.readFile(target)),B:hash(B),C:hash(C),R:hash(R),writerHash:OBJECT_WRITER_HASH,observerHash:OBJECT_HELPER_HASH,gitUnchanged:true,snapshot,transactions};
 }
 return {root,owner,scope,invoke,measure,verify,async dispose(){return cleanup();},async externalD(){await fs.writeFile(target,'external-D\nanchor-one\nbody\nanchor-two\nuser later\n');},target,C,R};
 }
 return {root,owner,scope,measure,phase:'ready',capture,async dispose(){return cleanup();}};
}
