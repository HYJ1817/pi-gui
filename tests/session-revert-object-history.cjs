const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');let passed=0,failed=0;
const check=async(name,fn)=>{try{await fn();passed++;console.log('ok '+name);}catch(e){failed++;console.error('FAIL '+name+': '+(e.code||e.name));}};
(async()=>{
 const {createSessionRevertObjectRecoveryReader:createReader}=await import('../server/session-revert-object-recovery-reader.js');
 const reader=createReader({dataDir:path.join(os.tmpdir(),'p33-d4-history-never-created')});
 await check('historical read-only methods exist',()=>{assert.equal(typeof reader.inspectHistorical,'function');assert.equal(typeof reader.readHistorical,'function');});
 if(typeof reader.inspectHistorical!=='function'){console.log(`Object history: ${passed}/${passed+failed}; failed=${failed}; skipped=0`);process.exitCode=1;return;}
 await check('default historical authorization rejects before private disk',async()=>{await assert.rejects(reader.inspectHistorical({planId:'missing'}),e=>e.code==='recovery_unauthorized');await assert.rejects(reader.readHistorical({planId:'missing',material:'current'}),e=>e.code==='recovery_unauthorized');});
 const {createSessionChangeStore}=await import('../server/session-change-store.js');
 const {objectFileId,OBJECT_WRITER_HASH}=await import('../server/session-revert-object-contract.js');
 const {objectScopeBinding}=await import('../server/session-revert-object-profile.js');
 const {OBJECT_HELPER_HASH}=await import('../server/session-revert-object-source.js');
 const owner={backendInstance:'old-backend',projectId:'fixture',repoId:null,workspaceId:'workspace',workspaceEpoch:'epoch',conversationId:'conversation',runtimeId:'runtime',runtimeGeneration:'old-generation',sessionId:'session'};
 const scope={runtimeOwner:owner,projectId:owner.projectId,repoId:null,workspaceId:owner.workspaceId,workspaceEpoch:owner.workspaceEpoch,conversationId:owner.conversationId,nativeSessionId:owner.sessionId,workspaceFingerprint:hash('root')};
 const C=Buffer.from('C\n'),R=Buffer.from('R\n');
 async function fixture(fn){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'p33-d4-history-')),capability=Object.freeze({});
  try{
   const options={dataDir:dir,privacyCheck:async()=>true,objectPlanAuthority:(_s,_id,c)=>c===capability};
   const store=await createSessionChangeStore(options);
   async function prepare(s,planId,operationId){
    const o={version:1,profileId:'windows-original-object-v1',status:'observed',source:{kind:'win32-observe',helperVersion:1,helperHash:OBJECT_HELPER_HASH},binding:{scope:objectScopeBinding(s),operationId,relativePathHash:hash('file.txt')},platform:{state:'known',osVersion:'10.0.26200.0',architecture:'x64',fileSystem:'NTFS',driveType:3,volumeId:'volume'},file:{state:'known',id:'file-object',links:1,bytes:C.length,attributes:32,reparse:false,isFile:true,digest:hash(C),encoding:'utf8'},path:{state:'known',relativePathHash:hash('file.txt'),parents:[{id:'parent',binding:hash('parent'),reparse:false}]},security:Object.fromEntries(['owner','group','dacl'].map(k=>[k,{state:'known',value:k}]).concat([['sacl',{state:'unavailable',value:null}]])),streams:{state:'known',names:['::$DATA']},ea:{state:'known',bytes:0},times:{state:'known',creation:'1',lastAccess:'2',lastWrite:'3'},nonAtomic:true};
    await store.configure(s,{enabled:true,acknowledged:true});
    await store.prepare(s,{operationId,toolCallId:operationId,path:'file.txt',before:C,intendedAfter:R,effectiveToolSource:'gui-protected-default',objectEvidenceVersion:1,beforeObjectEvidence:o});
    await store.settle(s,operationId,{observedAfter:R,toolOutcome:'success',mutationOutcome:'written',evidenceLevel:'intent_verified',objectEvidenceVersion:1,afterObjectEvidence:{...o,file:{...o.file,digest:hash(R),bytes:R.length}}});
    await store.amendOutcome(s,operationId,{toolOutcome:'success'});
    const currentRef=await store.restorePut(s,C),candidateRef=await store.restorePut(s,R),revision=(await store.previewRevision(s)).revision,at=Date.now();
    const input={schemaVersion:1,providerId:'windows-original-object-v1',profileId:'windows-original-object-v1',helperHash:OBJECT_WRITER_HASH,proofId:'isolated',riskNoticeVersion:2,planId,tokenHash:hash('token'),scope:s,kind:'revert',state:'prepared',completion:'prepared',expiresAt:at+60000,createdAt:at,updatedAt:at,evidenceRevision:revision,revision:revision+1,gapRevision:0,selectedOperationIds:[operationId],consumedOperationIds:[],sourcePlanId:null,requestId:null,files:[{action:'write_original',fileId:objectFileId(s,'file.txt'),relativePath:'file.txt',state:'prepared',operationIds:[operationId],currentRef,candidateRef,currentObject:o,intent:null}]};
    return store.objectCreate(s,input,{capability,expectedRevision:revision});
   }
   const plan=await prepare(scope,'old-plan','op'),journal=path.join(dir,'revert-evidence/v1/journal.jsonl');
   const before=await fs.readFile(journal),mtime=(await fs.stat(journal)).mtimeMs;
   await fn({dir,plan,prepare,journal,options});
   // Reader-only tests explicitly verify no journal writes; duplicate setup has
   // its own Store writes and checks its snapshot after preparing the duplicate.
   if((await fs.readFile(journal)).equals(before))assert.equal((await fs.stat(journal)).mtimeMs,mtime);
  }finally{assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^p33-d4-history-/);await fs.rm(dir,{recursive:true,force:true});}
 }
 await check('actual old-backend Store plan uses frozen verified historical owner and exact C/R',()=>fixture(async({dir,journal})=>{
  const before=await fs.readFile(journal),mtime=(await fs.stat(journal)).mtimeMs;let calls=0;
  const history=createReader({dataDir:dir,privacyCheck:async()=>true,authorizeHistorical:({scope:s,planId,readOnly,applyEligible})=>{calls++;assert.deepEqual(s,scope);assert.equal(Object.isFrozen(s),true);assert.equal(Object.isFrozen(s.runtimeOwner),true);assert.equal(planId,'old-plan');assert.equal(readOnly,true);assert.equal(applyEligible,false);return true;}});
  const info=await history.inspectHistorical({planId:'old-plan'});assert.equal(info.applyEligible,false);assert.equal(info.readOnly,true);assert.equal(info.damagedJournal,false);assert.equal(info.validPrefixBytes,before.length);assert.deepEqual(Object.keys(info).sort(),['applyEligible','damagedJournal','materials','planId','readOnly','state','validEvents','validPrefixBytes']);
  assert.deepEqual((await history.readHistorical({planId:'old-plan',material:'current'})).materials.current,C);assert.deepEqual((await history.readHistorical({planId:'old-plan',material:'candidate'})).materials.candidate,R);assert.equal(calls,3);
  assert.deepEqual(await fs.readFile(journal),before);assert.equal((await fs.stat(journal)).mtimeMs,mtime);
 }));
 await check('historical methods never accept client owner/scope/path/root fields',()=>fixture(async({dir})=>{
  let calls=0;const history=createReader({dataDir:dir,privacyCheck:async()=>true,authorizeHistorical:()=>{calls++;return true;}});
  for(const field of ['scope','owner','path','root','relativePath'])await assert.rejects(history.inspectHistorical({planId:'old-plan',[field]:scope}),e=>e.code==='invalid_evidence_operation');
  await assert.rejects(history.readHistorical({planId:'old-plan',material:'other'}),e=>e.code==='invalid_evidence_operation');assert.equal(calls,0);
 }));
 await check('trusted historical denial does not return private lookup result',()=>fixture(async({dir})=>{const history=createReader({dataDir:dir,privacyCheck:async()=>true,authorizeHistorical:()=>false});await assert.rejects(history.inspectHistorical({planId:'old-plan'}),e=>e.code==='recovery_unauthorized');}));
 await check('ordinary scoped read keeps full owner binding after backend restart',()=>fixture(async({dir})=>{const history=createReader({dataDir:dir,privacyCheck:async()=>true,authorize:()=>true,authorizeHistorical:()=>true});await assert.rejects(history.inspect({planId:'old-plan',scope:{...scope,runtimeOwner:{...owner,backendInstance:'new-backend',runtimeGeneration:'new-generation'}}}),e=>e.code==='recovery_prefix_insufficient');assert.deepEqual(Object.keys(history).sort(),['inspect','read']);}));
 await check('unknown plan cannot authorize using supplied callback',()=>fixture(async({dir})=>{let calls=0;const history=createReader({dataDir:dir,privacyCheck:async()=>true,authorizeHistorical:()=>{calls++;return true;}});await assert.rejects(history.inspectHistorical({planId:'missing'}),e=>e.code==='recovery_prefix_insufficient');assert.equal(calls,0);}));
 await check('duplicate planId across real Store owner scopes is refused',()=>fixture(async({dir,prepare})=>{await prepare({...scope,conversationId:'another-conversation',nativeSessionId:'another-session',runtimeOwner:{...owner,conversationId:'another-conversation',sessionId:'another-session',runtimeGeneration:'another-generation'}},'old-plan','another-op');let calls=0;const history=createReader({dataDir:dir,privacyCheck:async()=>true,authorizeHistorical:()=>{calls++;return true;}});await assert.rejects(history.inspectHistorical({planId:'old-plan'}),e=>e.code==='recovery_prefix_insufficient');assert.equal(calls,0);}));
 await check('corrupt material remains refused after historical authorization',()=>fixture(async({dir,plan})=>{await fs.writeFile(path.join(dir,'revert-evidence/v1/objects',plan.files[0].currentRef.digest),'wrong bytes');const history=createReader({dataDir:dir,privacyCheck:async()=>true,authorizeHistorical:()=>true});await assert.rejects(history.readHistorical({planId:'old-plan',material:'current'}),e=>e.code==='evidence_integrity_failed');}));
 await check('hash-bound valid prefix survives damaged tail without write eligibility',()=>fixture(async({dir,journal})=>{await fs.appendFile(journal,'{"broken":');const before=await fs.readFile(journal);const history=createReader({dataDir:dir,privacyCheck:async()=>true,authorizeHistorical:()=>true});const r=await history.inspectHistorical({planId:'old-plan'});assert.equal(r.damagedJournal,true);assert.equal(r.applyEligible,false);assert.deepEqual((await history.readHistorical({planId:'old-plan',material:'current'})).materials.current,C);assert.deepEqual(await fs.readFile(journal),before);}));
 await check('journal changes during trusted authorization cannot swap historical snapshot',()=>fixture(async({dir,journal})=>{const history=createReader({dataDir:dir,privacyCheck:async()=>true,authorizeHistorical:async()=>{await fs.appendFile(journal,'{"changed":');return true;}});await assert.rejects(history.inspectHistorical({planId:'old-plan'}),e=>e.code==='evidence_integrity_failed');}));
 console.log(`Object history: ${passed}/${passed+failed}; failed=${failed}; skipped=0`);if(failed)process.exitCode=1;
})().catch(e=>{console.error(e.code||e.name);process.exitCode=1;});
