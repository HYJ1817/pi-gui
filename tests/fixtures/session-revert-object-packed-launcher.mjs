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
   if(row.phase==='result'&&row.status==='verified'){
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
 const outcomes=[];
 for(const fault of [false,true]){
  const state={ready:0,actualVerified:0};
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
  },{relativePath:'中文 空格/file.txt',...(fault?{spawnProcess:pipeFault(state)}:{})});
 }
 emit({version:1,phase:'result',nonce,isSea:isSea(),bundled,helperHash:OBJECT_HELPER_HASH,writerHash:OBJECT_WRITER_HASH,outcomes});
 process.stdin.destroy();
}
