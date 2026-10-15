// Test-only SEA entry: a parent-created executable, fixed private control path,
// bounded anonymous stdio protocol. Never part of server/Electron composition.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {isSea,readAsset} from '../../lib/assets.js';
import {createRuntimeRegistry} from '../../server/runtime-registry.js';
import {createSessionChangeStore} from '../../server/session-change-store.js';
import {createSessionRevertObjectRecoveryReader} from '../../server/session-revert-object-recovery-reader.js';
import {createObjectServiceCore,createSessionRevertObjectService} from '../../server/session-revert-object-service.js';
import {openOriginalAttempt} from '../../server/session-revert-object-writer.js';
import {sameObjectScope,OBJECT_WRITER_HASH} from '../../server/session-revert-object-contract.js';
import {PRODUCTION_OBJECT_ALLOWLIST} from '../../server/session-revert-object-profile.js';
import {OBJECT_HELPER_HASH} from '../../server/session-revert-object-source.js';
import h from './session-revert-object-packed-issuer.cjs';
const emit=row=>process.stdout.write(JSON.stringify(row)+'\n'),hash=b=>createHash('sha256').update(b).digest('hex');
const control=path.join(path.dirname(process.execPath),'restart-control.json'),stage=process.argv.at(-1);
const nonce=randomBytes(32).toString('hex');emit({phase:'challenge',version:1,nonce});
let accepted=false,buffer='';const timer=setTimeout(()=>process.exit(2),15000);
process.stdin.on('data',b=>{if(accepted)return process.exit(2);buffer+=b;if(Buffer.byteLength(buffer)>512)return process.exit(2);if(!buffer.includes('\n'))return;accepted=true;clearTimeout(timer);try{assert.deepEqual(JSON.parse(buffer),{version:1,command:'run',nonce});}catch{return process.exit(2);}run().catch(error=>{emit({phase:'blocked',code:/^[a-z_]+$/.test(error?.code??'')?error.code:'restart_assertion_failed',line:String(error.stack).match(/:(\d+):\d+/)?.[1]??null});process.exit(1);});});
async function registryFor(root){
 const sessionId='11111111-1111-4111-8111-111111111111',locator=path.join(root,'fixture-session.jsonl');
 try{await fs.writeFile(locator,JSON.stringify({type:'session',version:3,id:sessionId,timestamp:new Date().toISOString(),cwd:root})+'\n',{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
 const workspace={projectId:'fixture',repoId:'repo',workspaceId:'workspace',workspaceEpoch:'epoch',cwd:root,root};
 const registry=createRuntimeRegistry({dataDir:path.join(root,'registry'),resolveWorkspace:async()=>workspace,factory:async(_context,emitEvent)=>({start(){emitEvent({type:'bridge_status',state:'ready'});},getState:()=>({bridgeState:'ready'}),request:async()=>({sessionId}),sessionLocator:async()=>locator,dispose:async()=>{}})});
 return {registry,workspace};
}
async function start(registry){const item=await registry.start({id:'workspace',epoch:'epoch'});for(let n=0;n<50;n++){const owner=registry.getOwner(item.conversationId);if(owner.sessionId)return owner;await new Promise(r=>setTimeout(r,10));}throw Error('registry_binding_timeout');}
async function run(){
 assert.equal(isSea(),true);assert.equal(hash(readAsset('revert-object/observe.ps1')),OBJECT_HELPER_HASH);assert.equal(hash(readAsset('revert-object/write.ps1')),OBJECT_WRITER_HASH);
 const formal=createSessionRevertObjectService({approved:true});for(const method of Object.keys(formal).filter(k=>k!=='dispose'))await assert.rejects(()=>formal[method](),{code:'production_allowlist_empty'});
 await assert.rejects(()=>openOriginalAttempt({approved:true}),{code:'production_allowlist_empty'});assert.equal(PRODUCTION_OBJECT_ALLOWLIST.length,0);
 if(stage==='first'){
  let registry,nativePid;
  await h.fixture(async x=>{
   const native=x.dependencies.openAttempt;
   await x.createService({openAttempt:async args=>{const attempt=await native(args);return {...attempt,commit:async()=>{
    const p=await x.store.objectGet(x.scope,args.authority.planId,{capability:x.dependencies.capability});assert.equal(p.state,'replacing');assert.equal(p.files[0].intent.attemptId,attempt.attemptId);
    const st=await fs.stat(x.root,{bigint:true});const record={root:x.root,scope:x.scope,planId:p.planId,confirmation,attemptId:attempt.attemptId,pid:process.pid,rootIdentity:[st.dev,st.ino,st.birthtimeNs].map(String)};
    const handle=await fs.open(control,'wx',0o600);try{await handle.writeFile(JSON.stringify(record));await handle.sync();}finally{await handle.close();}
    emit({phase:'checkpoint',isSea:true,pid:process.pid,backendInstance:x.scope.runtimeOwner.backendInstance,nativePid,durableReplacing:true,nativeReady:true,nativeCommitsSent:0});
    await new Promise(()=>{});
   }};}});
   const p=await x.service.prepareObjectRevert({},x.body),confirmation=x.confirmation(p,'restart-request');await x.service.applyObjectRevert({},confirmation);assert.fail('parent must terminate this process');
  },{createOwner:async root=>{({registry}=await registryFor(root));return start(registry);},spawnProcess:(...args)=>{const child=spawn(...args);nativePid=child.pid;return child;},timeoutMs:180000});
  return;
 }
 assert.equal(stage,'second');const old=JSON.parse(await fs.readFile(control,'utf8')),root=await fs.realpath(old.root),st=await fs.stat(root,{bigint:true});assert.equal(root,old.root);assert.deepEqual([st.dev,st.ino,st.birthtimeNs].map(String),old.rootIdentity);
 const {registry}=await registryFor(root);assert.notEqual(registry.snapshot().backendInstance,old.scope.runtimeOwner.backendInstance);assert.equal(registry.liveCount(),0);
 const history=registry.historyTarget(old.scope.conversationId);assert.equal(history.sessionId,old.scope.nativeSessionId);assert.equal(history.cwd,root);
 const owner=await start(registry),scope={...old.scope,runtimeOwner:owner,conversationId:owner.conversationId,nativeSessionId:owner.sessionId};
 const capability=Object.freeze({}),dataDir=path.join(root,'private-data');
 const store=await createSessionChangeStore({dataDir,objectPlanAuthority:(s,_id,c)=>c===capability&&sameObjectScope(s,old.scope)});
 const p=await store.objectGet(old.scope,old.planId,{capability});assert.equal(p.state,'recovery_required');assert.equal(p.restartReconciled,true);
 const journal=path.join(dataDir,'revert-evidence/v1/journal.jsonl'),before=await fs.readFile(journal);
 // Fixture access-control callback derives history from the real Registry and
 // fixed private control, never from the caller's suggested current owner.
 const reader=createSessionRevertObjectRecoveryReader({dataDir,authorizeHistorical:async value=>value.readOnly===true&&value.applyEligible===false&&value.planId===old.planId&&sameObjectScope(value.scope,old.scope)&&registry.historyTarget(value.scope.conversationId).sessionId===value.scope.nativeSessionId});
 const C=await reader.readHistorical({planId:old.planId,material:'current'}),R=await reader.readHistorical({planId:old.planId,material:'candidate'});
 assert.equal(C.materials.current.toString(),'agent\nanchor\nuser-new\n');assert.equal(R.materials.candidate.toString(),'base\nanchor\nuser-new\n');assert.deepEqual(await fs.readFile(journal),before);
 await assert.rejects(()=>Promise.resolve().then(()=>registry.getAdapter(old.scope.runtimeOwner)),{code:'stale_runtime'});
 const target=path.join(root,'file.txt'),D=Buffer.from('independent D after process restart\n');await fs.writeFile(target,D);
 let nativeOpens=0;const authority=async(_req,body,action)=>{registry.getAdapter(body.owner);return action({root,scope,revalidate:async()=>{registry.getAdapter(body.owner);}});};
 const service=createObjectServiceCore({store,capability,withAuthority:authority,withMutationAuthority:authority,qualify:async()=>assert.fail('no new qualification'),openAttempt:()=>{nativeOpens++;assert.fail('no Native after restart');}});
 await assert.rejects(()=>service.applyObjectRevert({},old.confirmation),{code:'stale_runtime'});
 await assert.rejects(()=>service.applyObjectRevert({},{...old.confirmation,owner,conversationId:owner.conversationId,attemptId:old.attemptId}));
 const evidenceRevision=(await store.previewRevision(scope)).revision;
 await assert.rejects(()=>service.prepareObjectRecovery({},{owner,conversationId:owner.conversationId,sourcePlanId:old.planId,evidenceRevision}));
 assert.deepEqual(await fs.readFile(target),D);assert.equal(nativeOpens,0);await service.dispose();await registry.dispose();
 emit({phase:'result',isSea:true,actualProcessRestart:true,newRegistryBackend:true,backendInstance:owner.backendInstance,previousPid:old.pid,reconciledState:p.state,historyMaterialsByteExact:true,historyJournalUnchanged:true,oldOwnerRejected:true,oldAttemptRejected:true,nativeOpensAfterRestart:0,nativeCommitsAfterRestart:0,currentDUnchanged:true,crossBackendRecovery:'blocked_contract',newRecoveryPlanCreated:false,formalServiceClosed:true,formalWriterClosed:true,allowlistEmpty:true,helperHash:OBJECT_WRITER_HASH,authorization:'fixture trusted historical grant; real Registry identity'});process.stdin.destroy();
}
