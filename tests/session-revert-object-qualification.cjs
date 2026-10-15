// D6 audit regression: current observations and operator consent are NOT a
// platform preservation proof. This suite never issues a production capability.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const crypto=require('node:crypto');
const path=require('node:path');
const h=require('./fixtures/session-revert-object-service-harness.cjs');
let passed=0;
const check=async(name,run)=>{await run();passed++;console.log('ok '+name);};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
 const profile=await import('../server/session-revert-object-profile.js');
 const contract=await import('../server/session-revert-object-contract.js');
 const writer=await import('../server/session-revert-object-writer.js');
 const service=await import('../server/session-revert-object-service.js');
 const resources=await import('../server/session-revert-object-resources.js');
 await check('current built-in observer and writer bytes match reviewed identities',async()=>{
  assert.equal(sha(await fs.readFile(path.join(h.base,'server/session-revert-object-native.ps1'))),resources.OBJECT_HELPER_HASH);
  assert.equal(sha(await fs.readFile(path.join(h.base,'server/session-revert-object-write-native.ps1'))),contract.OBJECT_WRITER_HASH);
 });
 await check('formal exports contain no TEMP issuer or executable core',async()=>{
  assert.equal(Object.hasOwn(writer,'createIsolatedWriter'),false);
  assert.equal(Object.hasOwn(service,'createObjectServiceCore'),false);
  assert.deepEqual(profile.PRODUCTION_OBJECT_ALLOWLIST,[]);
  assert.equal(Object.isFrozen(profile.PRODUCTION_OBJECT_ALLOWLIST),true);
 });
 const fakeApproval={approved:true,eligible:true,proofId:'p33-d2-isolated',capability:{},helperHash:contract.OBJECT_WRITER_HASH};
 await check('ordinary parameters and risk approval cannot open the formal writer',async()=>{
  await assert.rejects(()=>writer.openOriginalAttempt(fakeApproval),e=>e.code==='production_allowlist_empty');
 });
 for(const method of ['prepareObjectRevert','applyObjectRevert','cancelObjectRevert','inspectObjectRecovery','prepareObjectRecovery','exportVerifiedRecoveryMaterial']){
  await check('formal '+method+' refuses caller-supplied qualification',async()=>{
   const closed=service.createSessionRevertObjectService(fakeApproval);
   await assert.rejects(()=>closed[method]({},fakeApproval),e=>e.code==='production_allowlist_empty');
   await closed.dispose();
  });
 }
 if(process.platform!=='win32'){
  console.log(`Object qualification: ${passed}/${passed}; failed=0; skipped=8 (Windows observation only)`);return;
 }
 await h.fixture(async x=>{
  const {observeFileObject}=await import('../server/session-revert-object-observer.js');
  const evidence=await x.store.read(x.scope,x.evidenceId);
  const observation=await observeFileObject({root:x.root,relativePath:x.relativePath,scope:x.scope,operationId:x.evidenceId});
  const current={observation,scope:x.scope,gapRevision:0};
  const evaluate=(e=evidence,c=current,p=profile.READONLY_OBJECT_PROOF)=>profile.evaluateObjectProfile({evidence:e,current:c,platformProof:p,helperHash:resources.OBJECT_HELPER_HASH});
  await check('fresh current-token TEMP evidence remains unqualified for production',async()=>{
   const r=evaluate();assert.equal(r.qualification.eligible,false);assert.equal(r.qualification.reason,'production_allowlist_empty');
   assert.deepEqual(await fs.readFile(x.target),x.current);
   console.log('qualification observation '+JSON.stringify({osVersion:observation.platform.osVersion,architecture:observation.platform.architecture,fileSystem:observation.platform.fileSystem,driveType:observation.platform.driveType,saclState:observation.security.sacl.state,observerHash:resources.OBJECT_HELPER_HASH,writerHash:contract.OBJECT_WRITER_HASH,productionEligible:false}));
  });
  await check('foreign privileged witness label cannot upgrade a fresh current observation',async()=>{
   const r=evaluate(evidence,current,{...profile.READONLY_OBJECT_PROOF,proofId:'p33-d6-privileged-claim',approved:true});
   assert.equal(r.qualification.eligible,false);assert.equal(r.qualification.reason,'object_proof_unknown');
  });
  for(const field of ['owner','group','dacl'])await check('changed '+field+' refuses without using file identity as metadata proof',async()=>{
   const changed=structuredClone(current);changed.observation.security[field].value+='-changed';
   const r=evaluate(evidence,changed);assert.equal(r.qualification.eligible,false);assert.equal(r.qualification.reason,'object_metadata_changed');
  });
  await check('unavailable SACL remains unknown even when all visible observations match',async()=>{
   const e=structuredClone(evidence),c=structuredClone(current);
   for(const o of [e.beforeObjectEvidence,e.afterObjectEvidence,c.observation])o.security.sacl={state:'unavailable',value:null};
   const r=evaluate(e,c);assert.equal(r.qualification.eligible,false);assert.equal(r.qualification.reason,'production_allowlist_empty');
   for(const o of Object.values(r.observations))assert.deepEqual(o.security.sacl,{state:'unavailable',value:null});
  });
  await check('old capture cannot gain object evidence from the current observation',async()=>{
   const e=structuredClone(evidence);delete e.objectEvidenceVersion;delete e.beforeObjectEvidence;delete e.afterObjectEvidence;
   const r=evaluate(e);assert.equal(r.qualification.reason,'object_evidence_unavailable');assert.equal(r.qualification.eligible,false);
  });
  await check('qualification audit never opens Native writer and leaves prepared TEMP target unchanged',async()=>{
   assert.equal(x.state.nativeOpens,0);assert.equal(x.state.commitCalls,0);assert.deepEqual(await fs.readFile(x.target),x.current);
  });
 });
 console.log(`Object qualification: ${passed}/${passed}; failed=0; skipped=0 (real read-only Windows observation; synthetic capture and explicit metadata DI; NO production proof)`);
})().catch(e=>{console.error(e);process.exitCode=1;});
