const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
(async () => {
  const { createSessionRevertObjectRecoveryReader } = await import('../server/session-revert-object-recovery-reader.js');
  const { objectFileId, OBJECT_WRITER_HASH, validateObjectPlan } = await import('../server/session-revert-object-contract.js');
  const { objectScopeBinding } = await import('../server/session-revert-object-profile.js');
  const { OBJECT_HELPER_HASH } = await import('../server/session-revert-object-source.js');
  const { createSessionChangeStore } = await import('../server/session-change-store.js');
  const { recoveryMaterialPrivacy } = await import('../server/session-revert-object-material-reader.js');
  let passed = 0, skipped = 0;
  const check = async (name, fn) => { await fn(); passed++; console.log('ok ' + name); };
  const owner = { backendInstance:'D3', projectId:'fixture', repoId:null, workspaceId:'workspace', workspaceEpoch:'epoch', conversationId:'conversation', runtimeId:'runtime', runtimeGeneration:'generation', sessionId:'session' };
  const scope = { runtimeOwner:owner, projectId:owner.projectId, repoId:null, workspaceId:owner.workspaceId, workspaceEpoch:owner.workspaceEpoch, conversationId:owner.conversationId, nativeSessionId:owner.sessionId, workspaceFingerprint:hash('workspace') };
  const C = Buffer.from('\ufeffC\r\n'), R = Buffer.from('R\n'), currentRef = {digest:hash(C),bytes:C.length}, candidateRef = {digest:hash(R),bytes:R.length};
  const observation = {version:1, profileId:'windows-original-object-v1', status:'observed', source:{kind:'win32-observe',helperVersion:1,helperHash:OBJECT_HELPER_HASH}, binding:{scope:objectScopeBinding(scope),operationId:'op',relativePathHash:hash('file.txt')}, path:{state:'known',relativePathHash:hash('file.txt'),parents:[{id:'parent',binding:'parent',reparse:false}]}, file:{id:'object',links:1,isFile:true,reparse:false,encoding:'utf8',digest:currentRef.digest,bytes:C.length,attributes:32}, platform:{state:'known',osVersion:'10.0.26200.0',architecture:'x64',fileSystem:'NTFS',driveType:3,volumeId:'volume'}, ea:{state:'known',bytes:0}, streams:{state:'known',names:['::$DATA']}, security:Object.fromEntries(['owner','group','dacl','sacl'].map(k=>[k,{state:'known',value:k}]))};
  const plan = {schemaVersion:1,providerId:'windows-original-object-v1',profileId:'windows-original-object-v1',helperHash:OBJECT_WRITER_HASH,proofId:'isolated',riskNoticeVersion:2,planId:'plan',tokenHash:hash('token'),scope,kind:'revert',state:'replacing',completion:'replacing',expiresAt:61000,createdAt:1000,updatedAt:1001,evidenceRevision:1,revision:4,gapRevision:0,selectedOperationIds:['op'],consumedOperationIds:[],sourcePlanId:null,requestId:'request',files:[{action:'write_original',fileId:objectFileId(scope,'file.txt'),relativePath:'file.txt',state:'replacing',operationIds:['op'],currentRef,candidateRef,currentObject:observation,intent:{attemptId:'attempt',bindingDigest:hash('binding'),nativeIntentRevision:1,journalRevision:4,helperHash:OBJECT_WRITER_HASH,requestId:'request',readyDigest:currentRef.digest,readyObjectId:'object'}}]};
  observation.file.state='known';observation.times={state:'known',creation:'1',lastAccess:'2',lastWrite:'3'};plan.journalReserveRemaining=250000;
  validateObjectPlan(plan);
  const prepared=()=>({...plan,state:'prepared',completion:'prepared',revision:3,journalReserveRemaining:255000,requestId:null,files:[{...plan.files[0],state:'prepared',intent:null}]});
  const events = () => [{type:'apply',action:'restore_object',ref:currentRef},{type:'apply',action:'restore_object',ref:candidateRef},{type:'object_apply_v1',action:'plan',plan:prepared()},{type:'object_apply_v1',action:'plan',plan}];
  function journal(items, tail = '') {
    let chain=''; return items.map((item,index)=>{const body=JSON.stringify({...item,scope:item.scope??scope,revision:item.revision??index+1,at:1000+index});const next=hash(chain+'\n'+body),line=JSON.stringify({previous:chain,hash:next,body})+'\n';chain=next;return line;}).join('')+tail;
  }
  async function fixture(fn, {realPrivacy=false,items=events(),tail='',prefix=Buffer.alloc(0)}={}) {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'p33-D3-reader-'));
    const root=path.join(dir,'revert-evidence/v1'),objects=path.join(root,'objects'),file=path.join(root,'journal.jsonl');
    try {
      if(realPrivacy) await createSessionChangeStore({dataDir:dir});
      else await fs.mkdir(objects,{recursive:true,mode:0o700});
      await fs.writeFile(path.join(objects,currentRef.digest),C,{mode:0o600}); await fs.writeFile(path.join(objects,candidateRef.digest),R,{mode:0o600});
      await fs.writeFile(file,Buffer.concat([prefix,Buffer.from(journal(items,tail))]),{mode:0o600});
      const snapshot=await fs.readFile(file),before=await fs.stat(file);
      const options={dataDir:dir,authorize:()=>true,...(!realPrivacy?{privacyCheck:async()=>true}:{})};
      const reader=createSessionRevertObjectRecoveryReader(options);
      await fn({dir,root,objects,file,reader,options});
      assert.deepEqual(await fs.readFile(file),snapshot,'Reader does not change journal bytes');
      assert.equal((await fs.stat(file)).mtimeMs,before.mtimeMs,'Reader does not change journal mtime');
    } finally {
      assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^p33-D3-reader-/);
      await fs.rm(dir,{recursive:true,force:true});
    }
  }
  const request={scope,planId:'plan'};
  await check('hash-chain durable intent half-tail gives exact C/R without write eligibility',()=>fixture(async({reader,dir,options})=>{
    const result=await reader.inspect(request);assert.equal(result.damagedJournal,true);assert.equal(result.validEvents,4);assert.equal(result.state,'replacing');assert.equal(result.applyEligible,false);assert.equal(result.readOnly,true);
    assert.deepEqual((await reader.read({...request,material:'current'})).materials.current,C);assert.deepEqual((await reader.read({...request,material:'candidate'})).materials.candidate,R);
    assert.deepEqual(Object.keys(reader).sort(),['inspect','read']);
    await assert.rejects(()=>createSessionChangeStore({dataDir:dir,privacyCheck:options.privacyCheck}),e=>e.code==='evidence_integrity_failed');
  },{tail:'{"previous":"partial'}));
  await check('partial completion is not accepted as verified',()=>fixture(async({reader})=>{const r=await reader.inspect(request);assert.equal(r.state,'replacing');assert.equal(r.validEvents,4);assert.equal(r.damagedJournal,true);},{tail:'{"body":"applied_verified'}));
  await check('legacy apply namespace cannot authenticate a B draft plan',()=>fixture(async({reader})=>{await assert.rejects(()=>reader.inspect(request),e=>e.code==='recovery_prefix_insufficient');},{items:events().map(e=>e.plan?{...e,type:'apply'}:e)}));
  await check('B namespace cannot register arbitrary recovery material refs',()=>fixture(async({reader})=>{await assert.rejects(()=>reader.inspect(request),e=>e.code==='recovery_prefix_insufficient');},{items:[{...events()[0],type:'object_apply_v1'},...events().slice(1)]}));
  await check('B namespace cannot reinterpret a legacy A plan',()=>fixture(async({reader})=>{await assert.rejects(()=>reader.inspect(request),e=>e.code==='recovery_prefix_insufficient');},{items:[{type:'object_apply_v1',action:'plan',plan:{planId:'legacy',scope,state:'prepared',files:[]}},...events()]}));
  await check('initial replacing without durable prepared event is rejected',()=>fixture(async({reader})=>{await assert.rejects(()=>reader.inspect(request),e=>e.code==='recovery_prefix_insufficient');},{items:[events()[0],events()[1],{...events()[3],plan:{...plan,revision:3,files:[{...plan.files[0],intent:{...plan.files[0].intent,journalRevision:3}}]}}]}));
  await check('plan revision mismatch cuts prefix at prior prepared plan',()=>fixture(async({reader})=>{const result=await reader.inspect(request);assert.equal(result.state,'prepared');assert.equal(result.validEvents,3);assert.equal(result.damagedJournal,true);},{items:[...events().slice(0,3),{...events()[3],plan:{...plan,revision:9}}]}));
  await check('intent journalRevision mismatch cuts prefix at prior prepared plan',()=>fixture(async({reader})=>{const result=await reader.inspect(request);assert.equal(result.state,'prepared');assert.equal(result.validEvents,3);},{items:[...events().slice(0,3),{...events()[3],plan:{...plan,files:[{...plan.files[0],intent:{...plan.files[0].intent,journalRevision:3}}]}}]}));
  await check('event owner cannot authenticate plan of another generation',()=>fixture(async({reader})=>{const result=await reader.inspect(request);assert.equal(result.state,'prepared');assert.equal(result.validEvents,3);},{items:[...events().slice(0,3),{...events()[3],scope:{...scope,runtimeOwner:{...owner,runtimeGeneration:'foreign'}}}]}));
  for(const [label,patch] of [['token',{tokenHash:hash('other-token')}],['proof',{proofId:'foreign-proof'}],['kind/source',{kind:'recover',sourcePlanId:'another-plan',selectedOperationIds:[],files:[{...plan.files[0],operationIds:[]}]}],['expiresAt',{expiresAt:61001}],['evidence revision',{evidenceRevision:42}]])
    await check('immutable '+label+' change retains only previous valid prepared prefix',()=>fixture(async({reader})=>{const result=await reader.inspect(request);assert.equal(result.state,'prepared');assert.equal(result.validEvents,3);assert.equal(result.damagedJournal,true);},{items:[...events().slice(0,3),{...events()[3],plan:{...plan,...patch}}]}));
  await check('state reversal and terminal-state replay stop at prior valid intent',()=>fixture(async({reader})=>{const result=await reader.inspect(request);assert.equal(result.state,'replacing');assert.equal(result.validEvents,4);assert.equal(result.damagedJournal,true);},{items:[...events(),{type:'object_apply_v1',action:'plan',plan:{...prepared(),revision:5}}]}));
  await check('registered material current observation cannot mutate on transition',()=>fixture(async({reader})=>{const result=await reader.inspect(request);assert.equal(result.state,'prepared');assert.equal(result.validEvents,3);},{items:[...events().slice(0,3),{...events()[3],plan:{...plan,files:[{...plan.files[0],currentObject:{...observation,file:{...observation.file,id:'foreign-object'}},intent:{...plan.files[0].intent,readyObjectId:'foreign-object'}}]}}]}));
  const recovered={...plan,state:'recovery_required',completion:'recovery_required',revision:5,restartReconciled:true,files:[{...plan.files[0],state:'recovery_required'}]};
  await check('Store restart recovery-required event preserves valid intent materials',()=>fixture(async({reader})=>{const result=await reader.inspect(request);assert.equal(result.state,'recovery_required');assert.equal(result.validEvents,5);assert.equal(result.damagedJournal,false);assert.deepEqual((await reader.read({...request,material:'current'})).materials.current,C);},{items:[...events(),{type:'object_apply_v1',action:'plan',plan:recovered}]}));
  await check('terminal recovery-required replay cannot change durable state',()=>fixture(async({reader})=>{const result=await reader.inspect(request);assert.equal(result.state,'recovery_required');assert.equal(result.validEvents,5);assert.equal(result.damagedJournal,true);},{items:[...events(),{type:'object_apply_v1',action:'plan',plan:recovered},{type:'object_apply_v1',action:'plan',plan:{...recovered,revision:6}}]}));
  for(const reserve of [-1,262145,undefined])await check('invalid or missing initial journal reserve '+reserve+' rejects B prefix',()=>fixture(async({reader})=>{await assert.rejects(()=>reader.inspect(request),e=>e.code==='recovery_prefix_insufficient');},{items:[events()[0],events()[1],{...events()[2],plan:{...prepared(),journalReserveRemaining:reserve}}]}));
  await check('ordinary reserve increase cuts prefix at prepared event',()=>fixture(async({reader})=>{const result=await reader.inspect(request);assert.equal(result.state,'prepared');assert.equal(result.validEvents,3);},{items:[...events().slice(0,3),{...events()[3],plan:{...plan,journalReserveRemaining:256000}}]}));
  await check('legitimate restart reserve conservative rebuild may increase within maximum',()=>fixture(async({reader})=>{const result=await reader.inspect(request);assert.equal(result.state,'recovery_required');assert.equal(result.validEvents,5);assert.equal(result.damagedJournal,false);},{items:[...events(),{type:'object_apply_v1',action:'plan',plan:{...recovered,journalReserveRemaining:258000}}]}));
  const persistent={...scope};delete persistent.runtimeOwner;
  await check('B plan event owner stripping cannot authenticate its embedded full owner',()=>fixture(async({reader})=>{await assert.rejects(()=>reader.inspect(request),e=>e.code==='recovery_prefix_insufficient');},{items:[events()[0],events()[1],{...events()[2],scope:persistent}]}));
  await check('B refs cannot borrow owner from plan when restore-object owner is missing',()=>fixture(async({reader})=>{await assert.rejects(()=>reader.inspect(request),e=>e.code==='recovery_prefix_insufficient');},{items:[{...events()[0],scope:persistent},...events().slice(1)]}));
  await check('actual Store reserve-bearing prepared/replacing/applied journal prefix reads completely',async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'p33-D3-reader-store-')),capability=Object.freeze({});
    try {
      const store=await createSessionChangeStore({dataDir:dir,privacyCheck:async()=>true,objectPlanAuthority:(_s,_id,cap)=>cap===capability});
      await store.configure(scope,{enabled:true,acknowledged:true});
      await store.prepare(scope,{operationId:'op',toolCallId:'tool',path:'file.txt',before:C,intendedAfter:R,effectiveToolSource:'gui-protected-default',objectEvidenceVersion:1,beforeObjectEvidence:observation});
      await store.settle(scope,'op',{observedAfter:R,toolOutcome:'success',mutationOutcome:'written',evidenceLevel:'intent_verified',objectEvidenceVersion:1,afterObjectEvidence:{...observation,file:{...observation.file,digest:candidateRef.digest,bytes:candidateRef.bytes}}});
      await store.amendOutcome(scope,'op',{toolOutcome:'success'});
      await store.restorePut(scope,C);await store.restorePut(scope,R);
      let revision=(await store.previewRevision(scope)).revision;
      const at=Date.now(),input={...prepared(),createdAt:at,updatedAt:at,expiresAt:at+60000,evidenceRevision:revision,revision:revision+1};delete input.journalReserveRemaining;
      let p=await store.objectCreate(scope,input,{capability,expectedRevision:revision});
      const reader=createSessionRevertObjectRecoveryReader({dataDir:dir,authorize:()=>true,privacyCheck:async()=>true});
      const journalPath=path.join(dir,'revert-evidence/v1/journal.jsonl');
      async function verifiedRead(expected){const bytes=await fs.readFile(journalPath),mtime=(await fs.stat(journalPath)).mtimeMs,result=await reader.inspect(request);assert.equal(result.state,expected);assert.equal(result.damagedJournal,false);assert.equal(result.validPrefixBytes,bytes.length);assert.deepEqual(await fs.readFile(journalPath),bytes);assert.equal((await fs.stat(journalPath)).mtimeMs,mtime);}
      assert.ok(p.journalReserveRemaining<262144);await verifiedRead('prepared');
      const initialReserve=p.journalReserveRemaining;revision=p.revision;
      p=await store.objectUpdate(scope,p.planId,{state:'replacing',requestId:'request',files:[{...p.files[0],state:'replacing',intent:{...plan.files[0].intent,journalRevision:revision+1}}]},{capability,expectedRevision:revision});
      assert.ok(p.journalReserveRemaining<initialReserve);await verifiedRead('replacing');
      const intentReserve=p.journalReserveRemaining;revision=p.revision;
      p=await store.objectUpdate(scope,p.planId,{state:'applied_verified',files:[{...p.files[0],state:'applied_verified',observedPostDigest:candidateRef.digest,verifiedMeasurement:{digest:candidateRef.digest,bytes:candidateRef.bytes,id:observation.file.id,metadataEqual:true}}]},{capability,expectedRevision:revision});
      assert.ok(p.journalReserveRemaining<intentReserve);await verifiedRead('applied_verified');
    } finally {assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^p33-D3-reader-store-/);await fs.rm(dir,{recursive:true,force:true});}
  });
  await check('actual Store restart reserve rebuild accepts full recovery-required prefix',async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'p33-D3-reader-restart-')),capability=Object.freeze({}),options={dataDir:dir,privacyCheck:async()=>true,objectPlanAuthority:(_s,_id,c)=>c===capability};
    try {
      let store=await createSessionChangeStore(options);
      await store.configure(scope,{enabled:true,acknowledged:true});
      await store.prepare(scope,{operationId:'op',toolCallId:'tool',path:'file.txt',before:C,intendedAfter:R,effectiveToolSource:'gui-protected-default',objectEvidenceVersion:1,beforeObjectEvidence:observation});
      await store.settle(scope,'op',{observedAfter:R,toolOutcome:'success',mutationOutcome:'written',evidenceLevel:'intent_verified',objectEvidenceVersion:1,afterObjectEvidence:{...observation,file:{...observation.file,digest:candidateRef.digest,bytes:candidateRef.bytes}}});
      await store.amendOutcome(scope,'op',{toolOutcome:'success'});await store.restorePut(scope,C);await store.restorePut(scope,R);
      let revision=(await store.previewRevision(scope)).revision;const at=Date.now(),input={...prepared(),createdAt:at,updatedAt:at,expiresAt:at+60000,evidenceRevision:revision,revision:revision+1};delete input.journalReserveRemaining;
      let p=await store.objectCreate(scope,input,{capability,expectedRevision:revision});revision=p.revision;
      p=await store.objectUpdate(scope,p.planId,{state:'replacing',requestId:'request',files:[{...p.files[0],state:'replacing',intent:{...plan.files[0].intent,journalRevision:revision+1}}]},{capability,expectedRevision:revision});
      const before=p.journalReserveRemaining;store=await createSessionChangeStore(options);p=await store.objectGet(scope,p.planId,{capability});
      assert.equal(p.state,'recovery_required');assert.equal(p.restartReconciled,true);assert.ok(p.journalReserveRemaining>before);assert.ok(p.journalReserveRemaining<=262144);
      const journalPath=path.join(dir,'revert-evidence/v1/journal.jsonl'),bytes=await fs.readFile(journalPath),mtime=(await fs.stat(journalPath)).mtimeMs;
      const reader=createSessionRevertObjectRecoveryReader({dataDir:dir,authorize:()=>true,privacyCheck:async()=>true}),result=await reader.inspect(request);
      assert.equal(result.state,'recovery_required');assert.equal(result.damagedJournal,false);assert.equal(result.validPrefixBytes,bytes.length);assert.deepEqual((await reader.read({...request,material:'current'})).materials.current,C);assert.deepEqual(await fs.readFile(journalPath),bytes);assert.equal((await fs.stat(journalPath)).mtimeMs,mtime);
    }finally{assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^p33-D3-reader-restart-/);await fs.rm(dir,{recursive:true,force:true});}
  });
  await check('actual Store same refs registered by new generation preserve both owner-specific plans',async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'p33-D3-reader-generations-')),capability=Object.freeze({});
    const nextScope={...scope,runtimeOwner:{...owner,runtimeGeneration:'next-generation'}},options={dataDir:dir,privacyCheck:async()=>true,objectPlanAuthority:(s,_id,c)=>c===capability&&[scope,nextScope].some(x=>objectScopeBinding(x)===objectScopeBinding(s))};
    try {
      let store=await createSessionChangeStore(options);
      async function prepareFor(s,id,planId){
        const observed={...observation,binding:{...observation.binding,scope:objectScopeBinding(s),operationId:id}};
        await store.configure(s,{enabled:true,acknowledged:true});
        await store.prepare(s,{operationId:id,toolCallId:id,path:'file.txt',before:C,intendedAfter:R,effectiveToolSource:'gui-protected-default',objectEvidenceVersion:1,beforeObjectEvidence:observed});
        await store.settle(s,id,{observedAfter:R,toolOutcome:'success',mutationOutcome:'written',evidenceLevel:'intent_verified',objectEvidenceVersion:1,afterObjectEvidence:{...observed,file:{...observed.file,digest:candidateRef.digest,bytes:R.length}}});
        await store.amendOutcome(s,id,{toolOutcome:'success'});await store.restorePut(s,C);await store.restorePut(s,R);
        const revision=(await store.previewRevision(s)).revision,at=Date.now();
        const input={...prepared(),scope:s,planId,selectedOperationIds:[id],createdAt:at,updatedAt:at,expiresAt:at+60000,evidenceRevision:revision,revision:revision+1,files:[{...prepared().files[0],fileId:objectFileId(s,'file.txt'),operationIds:[id],currentObject:observed}]};delete input.journalReserveRemaining;
        return store.objectCreate(s,input,{capability,expectedRevision:revision});
      }
      await prepareFor(scope,'old-op','old-plan');store=await createSessionChangeStore(options);
      assert.equal((await store.objectGet(scope,'old-plan',{capability})).state,'not_applied');
      await prepareFor(nextScope,'next-op','next-plan');
      const journalPath=path.join(dir,'revert-evidence/v1/journal.jsonl'),bytes=await fs.readFile(journalPath),mtime=(await fs.stat(journalPath)).mtimeMs;
      const reader=createSessionRevertObjectRecoveryReader({dataDir:dir,authorize:()=>true,privacyCheck:async()=>true});
      for(const [s,id,state] of [[scope,'old-plan','not_applied'],[nextScope,'next-plan','prepared']]){
        const result=await reader.inspect({scope:s,planId:id});assert.equal(result.state,state);assert.equal(result.damagedJournal,false);assert.equal(result.validPrefixBytes,bytes.length);assert.deepEqual((await reader.read({scope:s,planId:id,material:'current'})).materials.current,C);
      }
      await assert.rejects(()=>reader.read({scope:nextScope,planId:'old-plan',material:'current'}),e=>e.code==='recovery_prefix_insufficient');
      assert.deepEqual(await fs.readFile(journalPath),bytes);assert.equal((await fs.stat(journalPath)).mtimeMs,mtime);
    }finally{assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^p33-D3-reader-generations-/);await fs.rm(dir,{recursive:true,force:true});}
  });
  await check('bad hash-chain before plan refuses ownership proof',()=>fixture(async({reader})=>{await assert.rejects(()=>reader.inspect(request),e=>e.code==='recovery_prefix_insufficient');},{items:events().slice(0,2),tail:JSON.stringify({previous:'wrong',hash:hash('x'),body:JSON.stringify({type:'object_apply_v1',action:'plan',scope,revision:3,plan})})+'\n'}));
  await check('missing prefix reference registration refuses material',()=>fixture(async({reader})=>{await assert.rejects(()=>reader.inspect(request),e=>e.code==='recovery_prefix_insufficient');},{items:[events()[0],events()[2]]}));
  await check('unknown B schema stops prefix and never skips ahead',()=>fixture(async({reader})=>{await assert.rejects(()=>reader.inspect(request),e=>e.code==='recovery_prefix_insufficient');},{items:[events()[0],events()[1],{...events()[2],plan:{...plan,schemaVersion:9}},events()[2]]}));
  await check('foreign runtime owner remains refused even trusted authorize true',()=>fixture(async({reader})=>{await assert.rejects(()=>reader.inspect({...request,scope:{...scope,runtimeOwner:{...owner,runtimeGeneration:'other'}}}),e=>e.code==='recovery_prefix_insufficient');}));
  await check('request project/repo derived from complete owner; conflicting fields denied',()=>fixture(async({reader})=>{const minimal={...scope};delete minimal.projectId;delete minimal.repoId;assert.deepEqual((await reader.read({...request,scope:minimal,material:'current'})).materials.current,C);await assert.rejects(()=>reader.inspect({...request,scope:{...scope,projectId:'foreign'}}),e=>e.code==='invalid_evidence_scope');}));
  await check('registered ref complete owner if present must match plan owner',()=>fixture(async({reader})=>{await assert.rejects(()=>reader.read({...request,material:'current'}),e=>e.code==='recovery_prefix_insufficient');},{items:[{...events()[0],scope:{...scope,runtimeOwner:{...owner,runtimeGeneration:'foreign'}}},events()[1],events()[2]]}));
  await check('scope epoch and fingerprint mismatch refuse',()=>fixture(async({reader})=>{for(const s of [{...scope,workspaceFingerprint:hash('foreign')},{...scope,workspaceEpoch:'other',runtimeOwner:{...owner,workspaceEpoch:'other'}}])await assert.rejects(()=>reader.inspect({...request,scope:s}),e=>e.code==='recovery_prefix_insufficient');}));
  await check('default authorization denies before disk access',async()=>{const reader=createSessionRevertObjectRecoveryReader({dataDir:path.join(os.tmpdir(),'nonexistent-D3-reader')});await assert.rejects(()=>reader.inspect(request),e=>e.code==='recovery_unauthorized');});
  await check('arbitrary path/ref/token and unknown material rejected',()=>fixture(async({reader})=>{for(const extra of [{path:'C:\\secret'},{ref:currentRef},{token:'token'}])await assert.rejects(()=>reader.inspect({...request,...extra}),e=>e.code==='invalid_evidence_operation');await assert.rejects(()=>reader.read({...request,material:'../secret'}),e=>e.code==='invalid_evidence_operation');}));
  await check('missing and corrupt object fail closed',()=>fixture(async({reader,objects})=>{await fs.writeFile(path.join(objects,currentRef.digest),Buffer.alloc(C.length,88));await assert.rejects(()=>reader.read({...request,material:'current'}),e=>e.code==='evidence_integrity_failed');await fs.unlink(path.join(objects,currentRef.digest));await assert.rejects(()=>reader.read({...request,material:'current'}));}));
  await check('hardlink object rejected',()=>fixture(async({reader,objects,dir})=>{await fs.link(path.join(objects,currentRef.digest),path.join(dir,'hardlink'));await assert.rejects(()=>reader.read({...request,material:'current'}),e=>e.code==='evidence_privacy_unavailable');}));
  await check('symlink ancestor rejected with otherwise existing journal',()=>fixture(async({dir,options})=>{const alias=path.join(dir,'alias');await fs.symlink(dir,alias,'junction');assert.equal((await fs.stat(path.join(alias,'revert-evidence/v1/journal.jsonl'))).isFile(),true);const reader=createSessionRevertObjectRecoveryReader({...options,dataDir:alias});await assert.rejects(()=>reader.inspect(request),e=>e.code==='evidence_privacy_unavailable');}));
  await check('injected privacy refusal and ACL change fail closed',()=>fixture(async({options})=>{let calls=0;const reader=createSessionRevertObjectRecoveryReader({...options,privacyCheck:async()=>++calls<4});await assert.rejects(()=>reader.inspect(request),e=>e.code==='evidence_privacy_unavailable');}));
  await check('journal, event, object, event-count and raw-byte budgets',()=>fixture(async({options})=>{for(const budgets of [{journalBytes:1},{eventBytes:1},{events:1},{rawBytes:1},{fileBytes:1}])await assert.rejects(()=>createSessionRevertObjectRecoveryReader({...options,budgets}).inspect(request));}));
  await check('invalid UTF8 full line stops prefix without decoding replacement',()=>fixture(async({reader})=>{await assert.rejects(()=>reader.inspect(request),e=>e.code==='recovery_prefix_insufficient');},{prefix:Buffer.from([0xff,10])}));
  await check('per-workspace revision discontinuity stops before plan',()=>fixture(async({reader})=>{await assert.rejects(()=>reader.inspect(request),e=>e.code==='recovery_prefix_insufficient');},{items:[events()[0],{...events()[1],revision:3},events()[2]]}));
  await check('plan scope cannot borrow foreign registered refs',()=>fixture(async({reader})=>{await assert.rejects(()=>reader.inspect(request),e=>e.code==='recovery_prefix_insufficient');},{items:[{...events()[0],scope:{...scope,conversationId:'other',nativeSessionId:'other'}},events()[1],events()[2]]}));
  await check('legacy A plan may coexist but never becomes B recovery material',()=>fixture(async({reader})=>{assert.deepEqual((await reader.read({...request,material:'candidate'})).materials.candidate,R);await assert.rejects(()=>reader.inspect({...request,planId:'legacy'}),e=>e.code==='recovery_prefix_insufficient');},{items:[{type:'apply',action:'plan',plan:{planId:'legacy',scope,state:'prepared',files:[]}},...events().map(e=>e.plan?{...e,plan:{...e.plan,revision:e.plan.revision+1,files:e.plan.files.map(f=>({...f,intent:f.intent?{...f.intent,journalRevision:f.intent.journalRevision+1}:null}))}}:e)]}));
  await check('invalid bounded event is not skipped to later B plan',()=>fixture(async({reader})=>{await assert.rejects(()=>reader.inspect(request),e=>e.code==='recovery_prefix_insufficient');},{items:[{type:'operation'},...events()]}));
  await check('recursive node budgets and deadline bound trusted callback',()=>fixture(async({options})=>{
    await assert.rejects(()=>createSessionRevertObjectRecoveryReader({...options,budgets:{nodes:2}}).inspect(request),e=>e.code==='recovery_budget_exceeded');
    await assert.rejects(()=>createSessionRevertObjectRecoveryReader({...options,budgets:{deadlineMs:1},authorize:async()=>{await new Promise(r=>setTimeout(r,5));return true;}}).inspect(request),e=>e.code==='recovery_budget_exceeded');
  }));
  await check('post-read private-file replacement is detected',()=>fixture(async({options,objects})=>{
    const target=path.join(objects,currentRef.digest);let seen=0;
    const reader=createSessionRevertObjectRecoveryReader({...options,privacyCheck:async p=>{if(p===target&&++seen===2){await fs.rename(target,target+'.old');await fs.writeFile(target,C);}return true;}});
    await assert.rejects(()=>reader.read({...request,material:'current'}),e=>e.code==='evidence_integrity_failed');
  }));
  if(process.platform==='win32') {
    await check('real Windows private root and inherited child ACL accepted',()=>fixture(async({reader,root,objects})=>{assert.equal(await recoveryMaterialPrivacy(root,false,true),true);assert.equal(await recoveryMaterialPrivacy(objects,false,false),true);assert.deepEqual((await reader.read({...request,material:'current'})).materials.current,C);},{realPrivacy:true,tail:'partial'}));
    await check('real Windows ordinary inherited TEMP root rejected without granting permissions',()=>fixture(async({dir})=>{const reader=createSessionRevertObjectRecoveryReader({dataDir:dir,authorize:()=>true});await assert.rejects(()=>reader.inspect(request),e=>e.code==='evidence_privacy_unavailable');}));
  } else skipped+=2;
  console.log(`Object recovery reader: ${passed}/${passed}; failed=0; skipped=${skipped}; filesystem fixtures; Native writer not invoked`);
})().catch(e => { console.error(e); process.exitCode = 1; });
