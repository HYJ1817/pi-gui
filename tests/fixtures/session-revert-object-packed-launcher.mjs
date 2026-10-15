// A separate TEMP test executable. This entry never enters production packages.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { isSea, hasBundledAssets, readAsset } from '../../lib/assets.js';
import { createSessionRevertObjectService } from '../../server/session-revert-object-service.js';
import { openOriginalAttempt } from '../../server/session-revert-object-writer.js';
import { OBJECT_HELPER_HASH } from '../../server/session-revert-object-source.js';
import { OBJECT_WRITER_HASH } from '../../server/session-revert-object-contract.js';
import h from './session-revert-object-packed-issuer.cjs';

const nonce=randomBytes(32).toString('hex');
const emit=o=>process.stdout.write(JSON.stringify(o)+'\n');
emit({version:1,phase:'challenge',nonce});
let input='',done=false;
const timer=setTimeout(()=>process.exit(2),15000);
process.stdin.on('data',chunk=>{
 if(done)return process.exit(2);input+=chunk.toString('utf8');
 if(Buffer.byteLength(input)>512)return process.exit(2);
 if(!input.includes('\n'))return;
 done=true;clearTimeout(timer);
 try{
  const row=JSON.parse(input);
  assert.equal(Object.keys(row).sort().join('|'),'command|nonce|version');
  assert.deepEqual(row,{version:1,command:'run',nonce});
 }catch{return process.exit(2);}
 void run().catch(e=>{emit({version:1,phase:'blocked',reason:e.code||'assertion_failed'});process.stdin.destroy();process.exitCode=1;});
});

function pipeFault(state){return (...args)=>{
 const child=spawn(...args),out=new PassThrough();let buffer='';
 child.stdout.on('data',chunk=>{
  buffer+=chunk.toString('utf8');
  while(buffer.includes('\n')){
   const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);
   const row=JSON.parse(line);
   if(row.phase==='ready')state.ready++;
   if(row.phase==='result'&&row.status==='verified'&&state.remainingFaults>0){
    state.remainingFaults--;
    state.actualVerified++;out.write('{invalid native result}\n');
   }else out.write(line+'\n');
  }
 });
 return new Proxy(child,{get(target,key){if(key==='stdout')return out;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
};}
async function run(){
 const bundled=hasBundledAssets();
 assert.equal(h.hash(readAsset(bundled?'revert-object/observe.ps1':'server/session-revert-object-native.ps1')),OBJECT_HELPER_HASH);
 assert.equal(h.hash(readAsset(bundled?'revert-object/write.ps1':'server/session-revert-object-write-native.ps1')),OBJECT_WRITER_HASH);
 const formal=createSessionRevertObjectService({approved:true,openAttempt:()=>assert.fail()});
 for(const key of Object.keys(formal).filter(k=>k!=='dispose'))await assert.rejects(()=>formal[key](),e=>e.code==='production_allowlist_empty');
 await assert.rejects(()=>openOriginalAttempt({approved:true}),e=>e.code==='production_allowlist_empty');
 const outcomes=[];let recovery=null;
 for(const fault of [false,true]){
  const state={ready:0,actualVerified:0,remainingFaults:fault?2:0};
  await h.fixture(async x=>{
   const native=x.dependencies.openAttempt;
   await x.createService({openAttempt:async args=>{
    const attempt=await native(args);
    return {...attempt,commit:async binding=>{
     const p=await x.store.objectGet(x.scope,args.authority.planId,{capability:x.dependencies.capability});
     assert.equal(p.state,'replacing');assert.equal(p.files[0].intent.attemptId,attempt.attemptId);
     return attempt.commit(binding);
    }};
   }});
   const p=await x.service.prepareObjectRevert({},x.body);
   const before=await x.store.objectGet(x.scope,p.planId,{capability:x.dependencies.capability});
   assert.deepEqual(await x.store.restoreRead(x.scope,before.files[0].currentRef),x.current);
   assert.equal((await x.store.restoreRead(x.scope,before.files[0].candidateRef)).toString(),'base\nanchor\nuser-new\n');
   const body=x.confirmation(p,'d4-request'),result=await x.service.applyObjectRevert({},body);
   assert.equal(result.completion,fault?'recovery_required':'applied_verified');assert.equal(result.durable,true);
   assert.equal(await fs.readFile(x.target,'utf8'),'base\nanchor\nuser-new\n');
   await x.reopen();await x.store.collectGarbage();
   const saved=await x.store.objectGet(x.scope,p.planId,{capability:x.dependencies.capability});
   assert.equal(saved.state,result.completion);
   assert.deepEqual(await x.store.restoreRead(x.scope,saved.files[0].currentRef),x.current);
   assert.equal((await x.store.restoreRead(x.scope,saved.files[0].candidateRef)).toString(),'base\nanchor\nuser-new\n');
   const calls=x.state.commitCalls;await x.service.applyObjectRevert({},body);assert.equal(x.state.commitCalls,calls);
   if(fault){assert.equal(state.ready,1);assert.equal(state.actualVerified,1);}
   outcomes.push({completion:saved.state,durable:result.durable,commits:x.state.commitCalls,pipeFault:fault,actualNativeVerified:fault?state.actualVerified:1});
   if(fault){
    // This is a separate test-only orchestration over the same service and
    // Native writer. Evidence/owner/qualification remain synthetic TEMP inputs.
    const C=Buffer.from(x.current),R=await x.store.restoreRead(x.scope,saved.files[0].candidateRef);
    const D=Buffer.from('external D after first packed result fault\nanchor\n'),D2=Buffer.from('external D after second packed result fault\nanchor\n');
    const plans=[saved],confirmations=[body],materials=[{current:C,candidate:R}];
    const readPlan=id=>x.store.objectGet(x.scope,id,{capability:x.dependencies.capability});
    async function reopenMaterials(){
     await x.service.dispose();await x.reopen();await x.createService();await x.store.collectGarbage();
     for(let i=0;i<plans.length;i++){
      const fresh=await readPlan(plans[i].planId);assert.equal(fresh.state,plans[i].state);
      assert.deepEqual(await x.store.restoreRead(x.scope,fresh.files[0].currentRef),materials[i].current);
      assert.deepEqual(await x.store.restoreRead(x.scope,fresh.files[0].candidateRef),materials[i].candidate);
      for(const material of ['current','candidate']){
       const exported=await x.service.exportVerifiedRecoveryMaterial({}, {owner:x.scope.runtimeOwner,conversationId:x.scope.conversationId,planId:fresh.planId,material});
       assert.equal(exported.readOnly,true);assert.equal(exported.applyEligible,false);
       assert.deepEqual(exported.bytes,materials[i][material]);assert.equal(exported.digest,h.hash(materials[i][material]));
      }
     }
    }
    await reopenMaterials();
    for(const [generation,external] of [D,D2].entries()){
     await fs.writeFile(x.target,external);
     const source=plans.at(-1),inspected=await x.service.inspectObjectRecovery({}, {owner:x.scope.runtimeOwner,conversationId:x.scope.conversationId,planId:source.planId});
     const fresh=await x.service.prepareObjectRecovery({}, {owner:x.scope.runtimeOwner,conversationId:x.scope.conversationId,sourcePlanId:source.planId,evidenceRevision:inspected.revision});
     assert.equal(fresh.backupReady,true);assert.equal(fresh.riskNoticeVersion,3);
     for(const prior of confirmations){assert.notEqual(fresh.planId,prior.planId);assert.notEqual(fresh.confirmationToken,prior.confirmationToken);}
     const prepared=await readPlan(fresh.planId);assert.equal(prepared.kind,'recover');assert.equal(prepared.sourcePlanId,source.planId);
     assert.deepEqual(await x.store.restoreRead(x.scope,prepared.files[0].currentRef),external);
     assert.deepEqual(await x.store.restoreRead(x.scope,prepared.files[0].candidateRef),C);
     assert.equal(prepared.files[0].currentObject.file.id,saved.files[0].currentObject.file.id);
     const confirmation=x.confirmation(fresh,'d6-recovery-'+generation),beforeCommit=x.state.commitCalls;
     for(const risk of Object.keys(confirmation.confirmation)){
      await assert.rejects(()=>x.service.applyObjectRevert({}, {...confirmation,confirmation:{...confirmation.confirmation,[risk]:false}}),e=>e.code==='confirmation_required');
     }
     await assert.rejects(()=>x.service.applyObjectRevert({}, {...confirmation,confirmationToken:confirmations.at(-1).confirmationToken}),e=>e.code==='confirmation_required');
     assert.equal(x.state.commitCalls,beforeCommit);
     const applied=await x.service.applyObjectRevert({},confirmation);
     assert.equal(applied.completion,generation===0?'recovery_required':'applied_verified');assert.equal(applied.durable,true);
     assert.equal(x.state.commitCalls,beforeCommit+1);assert.deepEqual(await fs.readFile(x.target),C);
     const complete=await readPlan(fresh.planId);plans.push(complete);confirmations.push(confirmation);materials.push({current:external,candidate:C});
     const calls=x.state.commitCalls;await x.service.applyObjectRevert({},confirmation);assert.equal(x.state.commitCalls,calls);
     await reopenMaterials();
    }
    assert.equal(x.state.commitCalls,3);assert.equal(state.actualVerified,2);assert.equal(state.remainingFaults,0);
    assert.deepEqual(plans.map(p=>p.state),['recovery_required','recovery_required','applied_verified']);
    const final=await readPlan(plans.at(-1).planId),measurement=final.files[0].verifiedMeasurement;
    assert.equal(measurement.id,saved.files[0].currentObject.file.id);assert.equal(measurement.metadataEqual,true);assert.equal(measurement.digest,h.hash(C));
    assert.deepEqual(await fs.readFile(x.target),C);
    recovery={states:plans.map(p=>p.state),commits:x.state.commitCalls,resultFaults:state.actualVerified,materialsByteExact:true,freshConfirmations:true,reopened:true,finalByteExact:true,objectMaintained:true,
     generations:plans.map((p,i)=>({kind:p.kind,state:p.state,currentDigest:h.hash(materials[i].current),candidateDigest:h.hash(materials[i].candidate)})),finalDigest:h.hash(C)};
   }
  },{relativePath:'中文 空格/file.txt',...(fault?{spawnProcess:pipeFault(state)}:{})});
 }
 emit({version:1,phase:'result',nonce,isSea:isSea(),bundled,helperHash:OBJECT_HELPER_HASH,writerHash:OBJECT_WRITER_HASH,outcomes,recovery});
 process.stdin.destroy();
}
