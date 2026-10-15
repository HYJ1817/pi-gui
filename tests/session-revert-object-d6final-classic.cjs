// Offline contract checks. SDK/RPC/Native opt-in: --offline-sdk-native.
const assert=require('node:assert/strict');
(async()=>{
 if(process.argv.includes('--offline-sdk-native')||process.argv.includes('--offline-managed-sdk-native')||process.argv.includes('--real-model'))return require('./fixtures/session-revert-object-d6final-run.cjs').main(process.argv.slice(2));
 assert.equal(process.argv.length,2,'unknown option');
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
 const {verifyTransactions,createCleanup,preserveFailure,safeFailure,saveInitialSnapshot,compareFinalSnapshot}=await import('./fixtures/session-revert-object-d6final-checks.mjs');
 let passed=0;const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
 const intent={intentRequestId:'q1',requestId:'q1',attemptId:'a1',readyDigest:'C',readyObjectId:'id',objectId:'id',bindingDigest:'bind'};
 const rows=[{planId:'cancel',kind:'revert',state:'not_applied',sourcePlanId:null,requestId:null,attemptId:null,currentDigest:'C',candidateDigest:'R'},{...intent,planId:'failed',kind:'revert',sourcePlanId:null,state:'recovery_required',currentDigest:'C',candidateDigest:'R'},{...intent,planId:'recovered',kind:'recover',state:'applied_verified',sourcePlanId:'failed',requestId:'q2',intentRequestId:'q2',attemptId:'a2',readyDigest:'D',currentDigest:'D',candidateDigest:'C'}];
 const verify=value=>verifyTransactions(value,{C:'C',R:'R',D:'D',commits:2,opens:2});
 await check('reproduce old two-plan assertion against legal cancellation',()=>assert.throws(()=>assert.equal(rows.length,2)));
 await check('retain all three independently bound transactions',()=>verify(rows));
 for(const [name,index,key,value] of [['duplicate plan',2,'planId','failed'],['wrong source',2,'sourcePlanId','cancel'],['shared request',2,'requestId','q1'],['shared attempt',2,'attemptId','a1'],['lost cancellation',0,'state','applied_verified'],['wrong D',2,'currentDigest','C'],['wrong R',1,'candidateDigest','C'],['wrong ready identity',2,'readyObjectId','foreign'],['intent mismatch',1,'intentRequestId','wrong']])await check(name,()=>{const mutated=structuredClone(rows);mutated[index][key]=value;assert.throws(()=>verify(mutated));});
 await check('reproduce old cleanup masking original error',async()=>{const primary=Error('primary'),secondary=Error('cleanup');const old=async()=>{try{throw primary;}catch(error){await Promise.reject(secondary);throw error;}};await assert.rejects(old(),error=>error===secondary);});
 await check('cleanup records all releases, remains idempotent, preserves original',async()=>{let calls=0;const cleanup=createCleanup([['one',()=>{calls++;throw Error('secret payload');}],['two',()=>{calls++;}]]),primary=Error('primary');await assert.rejects(preserveFailure(primary,cleanup),e=>e===primary);const first=await cleanup.run();assert.equal(await cleanup.run(),first);assert.equal(calls,2);assert.deepEqual(first.map(r=>r.ok),[false,true]);assert.ok(!JSON.stringify(first).includes('secret'));});
 await check('failure retains frames without exception values paths payloads',()=>{const output=safeFailure(Error('secret SDDL token'), 'verify');assert.ok(output.frames.length);assert.ok(!JSON.stringify(output).includes('secret'));assert.ok(!JSON.stringify(output).includes(__dirname));});
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'p33-D6final-contract-')),target=path.join(root,'file.txt'),snapshot=path.join(root,'initial.json');
 const git=(...a)=>execFileSync('git',['-C',root,...a],{stdio:'pipe'});
 git('init','--quiet');git('config','core.autocrlf','false');await fs.writeFile(target,'initial\n');git('add','file.txt');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','fixture');
 const identity={repo:root,workspace:root,target,owner:{backendInstance:'TEMP',workspaceEpoch:'1'},scope:{workspaceFingerprint:'TEMP'}};
 await check('persist initial HEAD refs index target bytes and identity before edits',async()=>{const v=await saveInitialSnapshot(snapshot,identity);assert.equal(Buffer.from(v.initialTarget.base64,'base64').toString(),'initial\n');assert.ok(v.repo.head&&v.repo.refs&&v.repo.indexDigest);});
 await check('later target edits preserve Git and identity exact comparison',async()=>{await fs.writeFile(target,'later\n');assert.equal((await compareFinalSnapshot(snapshot,identity)).gitUnchanged,true);});
 await check('changed workspace identity rejected',async()=>assert.rejects(compareFinalSnapshot(snapshot,{...identity,owner:{backendInstance:'other'}})));
 await check('changed index rejected',async()=>{git('add','file.txt');await assert.rejects(compareFinalSnapshot(snapshot,identity));});
 await check('initial snapshot cannot be overwritten',async()=>assert.rejects(saveInitialSnapshot(snapshot,identity)));
 console.log(JSON.stringify({passed,failed:0,skipped:0,modelRequests:0,credentialsRead:false,layer:'offline-contract',realModel:'REAL_MODEL_RETEST_PENDING',root}));
})().catch(error=>{console.error(error);process.exitCode=1;});
