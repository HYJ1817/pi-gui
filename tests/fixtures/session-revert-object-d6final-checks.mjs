import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',windowsHide:true,stdio:'pipe'}).trim();
export async function gitSnapshot(root){
 return {head:git(root,'rev-parse','HEAD'),refs:git(root,'show-ref'),indexDigest:digest(await fs.readFile(path.resolve(root,git(root,'rev-parse','--git-path','index'))))};
}
export async function saveInitialSnapshot(file,{repo,workspace,target,owner,scope}){
 const bytes=await fs.readFile(target);
 const snapshot={version:1,repo:await gitSnapshot(repo),workspace:await gitSnapshot(workspace),initialTarget:{bytes:bytes.length,digest:digest(bytes),base64:bytes.toString('base64')},identity:{owner,scope}};
 const bytesOnDisk=Buffer.from(JSON.stringify(snapshot,null,2)),handle=await fs.open(file,'wx',0o600);
 try{await handle.writeFile(bytesOnDisk);await handle.sync();}finally{await handle.close();}
 assert.deepEqual(await fs.readFile(file),bytesOnDisk);return snapshot;
}
export async function compareFinalSnapshot(file,{repo,workspace,owner,scope}){
 const before=JSON.parse(await fs.readFile(file,'utf8'));
 assert.deepEqual({repo:await gitSnapshot(repo),workspace:await gitSnapshot(workspace)},{repo:before.repo,workspace:before.workspace});
 assert.deepEqual({owner,scope},before.identity);
 assert.equal(digest(Buffer.from(before.initialTarget.base64,'base64')),before.initialTarget.digest);
 return {gitUnchanged:true,identityUnchanged:true,snapshotDigest:digest(await fs.readFile(file)),initialTargetDigest:before.initialTarget.digest};
}
// Never include exception messages, arbitrary properties, assertion values or paths.
// Frame names and line/column positions retain the useful stack structure.
export function safeFailure(error,phase){
 const frames=String(error?.stack??'').split('\n').slice(1).map(line=>{const at=line.trim().match(/^at\s+(?:(.*?)\s+\()?[^\n]*?:(\d+):(\d+)\)?$/);return at?{function:/^[\w.$<> ]{1,120}$/.test(at[1]??'')?at[1]:'anonymous',line:Number(at[2]),column:Number(at[3])}:{function:'redacted'};});
 return {phase:/^[a-zA-Z0-9_-]{1,80}$/.test(phase)?phase:'unknown',name:['Error','AssertionError','TypeError','AggregateError'].includes(error?.name)?error.name:'Error',code:/^[a-z_]{1,80}$/.test(error?.code??'')?error.code:'fixture_failure',frames};
}
export function createCleanup(steps){
 let task;const records=[];
 return {records,run(){return task??= (async()=>{for(const [phase,run] of steps){try{await run();records.push({phase,ok:true});}catch(error){records.push({phase,ok:false,error:safeFailure(error,phase)});}}return records;})();}};
}
export async function preserveFailure(error,cleanup){await cleanup.run();throw error;}
export function verifyTransactions(rows,{C,R,D,commits,opens}){
 assert.equal(rows.length,3);assert.equal(new Set(rows.map(p=>p.planId)).size,3);
 const cancelled=rows.find(p=>p.state==='not_applied'),failed=rows.find(p=>p.state==='recovery_required'),recovered=rows.find(p=>p.state==='applied_verified');
 assert.ok(cancelled&&failed&&recovered);
 for(const row of [cancelled,failed]){assert.equal(row.kind,'revert');assert.equal(row.sourcePlanId,null);assert.equal(row.currentDigest,C);assert.equal(row.candidateDigest,R);}
 assert.equal(cancelled.requestId,null);assert.equal(cancelled.attemptId,null);
 assert.equal(recovered.kind,'recover');assert.equal(recovered.sourcePlanId,failed.planId);assert.equal(recovered.currentDigest,D);assert.equal(recovered.candidateDigest,C);
 assert.ok(failed.requestId&&recovered.requestId&&failed.requestId!==recovered.requestId);
 assert.ok(failed.attemptId&&recovered.attemptId&&failed.attemptId!==recovered.attemptId);
 for(const row of [failed,recovered]){assert.equal(row.intentRequestId,row.requestId);assert.equal(row.readyDigest,row.currentDigest);assert.equal(row.readyObjectId,row.objectId);assert.ok(row.bindingDigest);}
 assert.equal(commits,2);assert.equal(opens,2);return {cancelled:cancelled.planId,failed:failed.planId,recovered:recovered.planId};
}
