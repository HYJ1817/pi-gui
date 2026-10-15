// Test-only TEMP issuer. All roots/materials are created here, never by renderer.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
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
const wait=async fn=>{const end=Date.now()+20000;while(!await fn()){if(Date.now()>end)fail('fixture_timeout');await new Promise(r=>setTimeout(r,35));}};
function pipeFault(measure){return (...args)=>{
 const child=spawn(...args),output=new PassThrough();let buffer='';
 child.stdout.on('data',b=>{buffer+=b.toString();while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);const row=JSON.parse(line);if(row.phase==='result'&&row.status==='verified'){measure.actualNativeVerified++;output.write('{D5 injected uncertain response}\n');}else output.write(line+'\n');}});
 child.stdout.on('end',()=>output.end());
 return new Proxy(child,{get(t,k){if(k==='stdout')return output;const v=Reflect.get(t,k,t);return typeof v==='function'?v.bind(t):v;}});
};}
export async function createD5Fixture({rpcLauncher,fault=false}={}){
 assert.equal(OBJECT_RISK_VERSION,3);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'p33-D5-native-')),workspace=path.join(root,'workspace'),dataDir=path.join(root,'private-data'),agentDir=path.join(root,'agent'),sessions=path.join(root,'sessions');
 for(const dir of [workspace,agentDir,sessions])await fs.mkdir(dir);
 const B=Buffer.from('user preexisting\nanchor-one\nbody\nanchor-two\ntail\n'),C=Buffer.from('agent-one\nanchor-one\nagent-two\nanchor-two\nuser later\n'),R=Buffer.from('user preexisting\nanchor-one\nbody\nanchor-two\nuser later\n');
 const target=path.join(workspace,'file.txt');await fs.writeFile(target,B);
 git(workspace,'init','--quiet');git(workspace,'config','core.autocrlf','false');git(workspace,'add','file.txt');git(workspace,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','D5 fixture');
 const gitBefore={refs:git(workspace,'show-ref'),head:git(workspace,'rev-parse','HEAD'),index:hash(await fs.readFile(path.join(workspace,'.git/index')))};
 const owner=Object.fromEntries(['backendInstance','projectId','repoId','workspaceId','workspaceEpoch','conversationId','runtimeId','runtimeGeneration','sessionId'].map(k=>[k,randomUUID()]));owner.repoId=null;
 const stat=await fs.stat(workspace),scope={runtimeOwner:owner,projectId:owner.projectId,repoId:null,workspaceId:owner.workspaceId,workspaceEpoch:owner.workspaceEpoch,conversationId:owner.conversationId,nativeSessionId:owner.sessionId,workspaceFingerprint:hash(JSON.stringify([stat.dev,stat.ino,stat.birthtimeMs]))};
 const cap=Object.freeze({}),storeCaps=new WeakSet([cap]),nativeCaps=new WeakSet(),attempts=[],plans=new Map();let active=true,service,rpc;
 const measure={root,commits:0,opens:0,stops:0,rpcTools:[],actualNativeVerified:0,fault,sourceVerified:false};
 const store=await createSessionChangeStore({dataDir,objectPlanAuthority:(s,_id,c)=>active&&storeCaps.has(c)&&sameObjectScope(scope,s)});
 const admission=createSessionRevertAdmission();
 let serial=0,buffer='',pending=new Map(),settled=0;
 const command=(type,extra={})=>new Promise((resolve,reject)=>{const id='d5-rpc-'+(++serial),timer=setTimeout(()=>{pending.delete(id);reject(Error('rpc_timeout'));},20000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject});rpc.stdin.write(JSON.stringify({id,type,...extra})+'\n');});
 const withAuthority=async(_req,body,fn)=>{
  if(!active||body?.owner&&JSON.stringify(body.owner)!==JSON.stringify(owner)||body?.conversationId&&body.conversationId!==owner.conversationId)fail('stale_runtime');
  const state=await command('get_state');if(state.sessionId!==owner.sessionId)fail('stale_runtime');
  return fn({root:workspace,scope,activeWriter:state.isStreaming===true,revalidate:async()=>{if(!active||(await command('get_state')).sessionId!==owner.sessionId)fail('stale_runtime');}});
 };
 const extensionFile=path.join(materializeDir('extensions/pi-gui-revert'),'index.js');
 const launch=createPiLaunch(),packageDir=launch.packageDir();assert.ok(packageDir);
 const installed=JSON.parse(await fs.readFile(path.join(packageDir,'package.json'),'utf8')),apiTypes=await fs.readFile(path.join(packageDir,'dist/index.d.ts'),'utf8');
 assert.equal(installed.exports?.['.']?.import,'./dist/index.js');for(const n of ['createWriteToolDefinition','createEditToolDefinition','runRpcMode'])assert.ok(apiTypes.includes(n),'actual installed public API '+n);
 measure.piVersion=installed.version;
 // Explicit private compatibility probe, followed by real source+tool evidence.
 // Does not broaden the production bridge's version allowlist.
 const bridge=createSessionChangeBridge({store,launch,supported:true,admission,resolveScope:async()=>scope,withAuthority:fn=>fn({root:workspace}),extensionPath:extensionFile,inspectFileMetadata,inspectObjectEvidence:observeFileObject});
 const prepared=await bridge.prepare();assert.ok(prepared,'actual installed Pi bridge source support: '+JSON.stringify({packageDir,packageVersion:JSON.parse(await fs.readFile(path.join(packageDir,'package.json'),'utf8')).version,reason:bridge.report().reason}));
 const sessionFile=path.join(sessions,'2026-10-14T00-00-00-000Z_'+owner.sessionId+'.jsonl');
 await fs.writeFile(sessionFile,JSON.stringify({type:'session',version:3,id:owner.sessionId,timestamp:new Date().toISOString(),cwd:workspace})+'\n');
 const rpcConfig=path.join(root,'private-rpc-config.json');await fs.writeFile(rpcConfig,JSON.stringify({packageDir,workspace,agentDir,sessionFile,extensionFile,captureEnvironment:prepared.env}),{mode:0o600});
 rpc=spawn(process.execPath,[rpcLauncher,rpcConfig],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']});
 let privateError='';rpc.stderr.on('data',b=>{privateError+=b.toString();});
 rpc.stdout.on('data',b=>{buffer+=b.toString();while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);let row;try{row=JSON.parse(line);}catch{continue;}if(row.type==='response'&&pending.has(row.id)){const p=pending.get(row.id);pending.delete(row.id);row.success?p.resolve(row.data):p.reject(Error('rpc_command_failed: '+row.error));}if(row.type==='agent_settled')settled++;if(row.type==='tool_execution_end')measure.rpcTools.push({toolName:row.toolName,toolCallId:row.toolCallId});}});
 rpc.on('exit',()=>{for(const p of pending.values())p.reject(Error('rpc_child_exit'));pending.clear();});
 try{
  await wait(async()=>{if(rpc.exitCode!==null){await fs.writeFile(path.join(root,'rpc-private-error.txt'),privateError);fail('rpc_start_failed');}return (await bridge.summary()).sourceVerified;});measure.sourceVerified=true;
  const connection={url:prepared.env.PI_GUI_SESSION_CHANGE_URL,token:prepared.env.PI_GUI_SESSION_CHANGE_TOKEN};
  // Existing authenticated capture transport, never an Object Apply interface.
  await fetch(new URL('/configure',connection.url),{method:'POST',headers:{'content-type':'application/json','x-pi-session-change-token':connection.token},body:JSON.stringify({nativeSessionId:owner.sessionId,enabled:true,acknowledged:true,exclusions:[]})}).then(async r=>{if(!r.ok)fail('capture_configure_failed');});
  for(const prompt of ['D5 write fixture','D5 edit fixture']){const prior=settled;await command('prompt',{message:prompt});await wait(()=>settled>prior);}
  const summary=await store.summary(scope);assert.equal(summary.operationCount,2);
  for(const row of summary.operations){const r=await store.read(scope,row.operationId);assert.equal(r.evidenceLevel,'intent_verified');assert.equal(r.objectEvidenceVersion,1);assert.equal(r.toolResultObserved,true);assert.equal(r.beforeObjectEvidence.status,'observed');assert.equal(r.afterObjectEvidence.status,'observed');}
  assert.equal(measure.rpcTools.length,2);assert.deepEqual(measure.rpcTools.map(r=>r.toolName),['write','edit']);
  await fs.writeFile(target,C);
 }catch(e){rpc.kill();await bridge.dispose();throw e;}
 const withMutationAuthority=createSessionRevertMutationAuthority({withAuthority,admission,stopAndDrain:async()=>{measure.stops++;await command('abort');await wait(async()=>!(await command('get_state')).isStreaming);}});
 const helperBytes=readAsset(hasBundledAssets()?'revert-object/write.ps1':'server/session-revert-object-write-native.ps1');assert.equal(hash(helperBytes),OBJECT_WRITER_HASH);
 let faultPending=fault===true?1:Number(fault)||0;
 const makeWriter=uncertain=>createIsolatedWriter({owns:a=>active&&nativeCaps.has(a),helperBytes,materials:async(a,c,r)=>{assert.equal(nativeCaps.has(a),true);return [await store.restoreDescriptor(scope,c),await store.restoreDescriptor(scope,r)];},admit:o=>{assert.equal(o.status,'observed');assert.equal(o.binding.scope,objectScopeBinding(scope));assert.equal(o.file.links,1);assert.equal(o.file.reparse,false);assert.equal(o.file.encoding,'utf8');assert.deepEqual(o.streams.names,['::$DATA']);assert.equal(o.ea.bytes,0);for(const k of ['owner','group','dacl'])assert.equal(o.security[k].state,'known');},...(uncertain?{spawnProcess:pipeFault(measure)}:{})});
 service=createObjectServiceCore({store,withAuthority,withMutationAuthority,capability:cap,qualify:async()=>({proofId:'p33-d2-isolated',helperHash:OBJECT_WRITER_HASH}),openAttempt:async args=>{assert.equal(args.authority.root,workspace);const a=Object.freeze({...args.authority});nativeCaps.add(a);const w=makeWriter(faultPending>0);faultPending=Math.max(0,faultPending-1);const attempt=await w({...args,authority:a});attempts.push(attempt);measure.opens++;return {...attempt,commit:async v=>{measure.commits++;return attempt.commit(v);}};}});
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
  const saved=[];for(const id of plans.keys()){const p=await store.objectGet(scope,id,{capability:cap}),f=p.files[0],actualCurrent=await store.restoreRead(scope,f.currentRef),actualCandidate=await store.restoreRead(scope,f.candidateRef);assert.equal(hash(actualCurrent),f.currentRef.digest);assert.equal(hash(actualCandidate),f.candidateRef.digest);if(p.kind==='revert'){assert.deepEqual(actualCurrent,C);assert.deepEqual(actualCandidate,R);}else{assert.deepEqual(actualCandidate,C);assert.deepEqual(actualCurrent,plans.get(id).expectedCurrent);}if(p.state==='applied_verified')assert.equal(f.verifiedMeasurement.id,f.currentObject.file.id);saved.push({planId:id,kind:p.kind,state:p.state,currentDigest:f.currentRef.digest,candidateDigest:f.candidateRef.digest,materialBytesExact:true,measuredCurrentDigest:hash(plans.get(id).expectedCurrent),objectId:f.currentObject.file.id,verifiedObjectId:f.verifiedMeasurement?.id??null,metadataEqual:f.verifiedMeasurement?.metadataEqual??null});}
  assert.deepEqual({refs:git(workspace,'show-ref'),head:git(workspace,'rev-parse','HEAD'),index:hash(await fs.readFile(path.join(workspace,'.git/index')))},gitBefore);
  return {...measure,scope,saved,finalDigest:hash(await fs.readFile(target)),B:hash(B),C:hash(C),R:hash(R),writerHash:OBJECT_WRITER_HASH,observerHash:OBJECT_HELPER_HASH,gitUnchanged:true};
 }
 return {root,owner,scope,invoke,measure,verify,async dispose(){active=false;await service.dispose();await Promise.allSettled(attempts.map(a=>a.close()));rpc.stdin.end();await bridge.dispose();},async externalD(){await fs.writeFile(target,'external-D\nanchor-one\nbody\nanchor-two\nuser later\n');},target,C,R};
}
