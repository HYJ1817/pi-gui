import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { observeFileObject } from './session-revert-object-observer.js';
import { evaluateObjectProfile, READONLY_OBJECT_PROOF, OBJECT_PROFILE_ID } from './session-revert-object-profile.js';
import { OBJECT_HELPER_HASH } from './session-revert-object-source.js';
import { runSessionRevert } from './session-revert-compute.js';
import { boundedRevertDiff } from './session-revert-service.js';
import { OBJECT_PROVIDER_ID, OBJECT_WRITER_HASH, OBJECT_RISK_VERSION, objectHash, objectFail as fail, objectIdentifier as id, objectFileId, objectRelativePath, sameObjectScope, validateObjectPlan } from './session-revert-object-contract.js';

const METHODS=['prepareObjectRevert','applyObjectRevert','cancelObjectRevert','inspectObjectRecovery','prepareObjectRecovery','exportVerifiedRecoveryMaterial'];
// No option, request, environment setting or exported factory enables this provider.
export function createSessionRevertObjectService(){return Object.freeze(Object.fromEntries([...METHODS.map(name=>[name,async()=>fail('production_allowlist_empty')]),['dispose',async()=>{}]]));}
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('|')===keys.slice().sort().join('|');
const closed=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).every(k=>keys.includes(k));
const safeError=e=>new Set(['stale_evidence','stale_current','stale_runtime','stale_workspace','active_writer','plan_expired','confirmation_required','plan_consumed','backup_invalid','recovery_required','evidence_integrity_failed','evidence_storage_failed','evidence_quota_exceeded','native_not_ready','native_unconfirmed','invalid_commit','object_metadata_changed','object_identity_changed']).has(e?.code)?e.code:'object_restore_unconfirmed';
const normalizedScope=s=>({...s,projectId:s.projectId??s.runtimeOwner?.projectId,repoId:s.repoId??s.runtimeOwner?.repoId??null,workspaceFingerprint:s.workspaceFingerprint??null});
const metadataEqual=(a,b)=>a.file.id===b.file.id&&a.file.attributes===b.file.attributes&&a.platform.volumeId===b.platform.volumeId&&a.times.creation===b.times.creation&&JSON.stringify(a.path)===JSON.stringify(b.path)&&['owner','group','dacl'].every(k=>a.security[k].value===b.security[k].value)&&JSON.stringify(a.streams)===JSON.stringify(b.streams)&&JSON.stringify(a.ea)===JSON.stringify(b.ea)&&(a.security.sacl.state!=='known'||b.security.sacl.state==='known'&&a.security.sacl.value===b.security.sacl.value);
const statKey=s=>[s.dev,s.ino,s.birthtimeMs,s.size,s.mtimeMs,s.ctimeMs,s.nlink].join(':');
async function inspectOriginal(authority,relativePath,operationId){
 const relative=objectRelativePath(relativePath);
 if(!path.isAbsolute(authority.root)||authority.root.startsWith('\\\\'))fail('unsupported_path');
 const observation=await observeFileObject({root:authority.root,relativePath:relative,scope:authority.scope,operationId});
 if(observation.status!=='observed')fail('object_observation_unavailable');
 return readObservedOriginal(authority,relative,observation);
}
async function readObservedOriginal(authority,relativePath,observation){
 const relative=objectRelativePath(relativePath),absolute=path.resolve(authority.root,...relative.split('/'));
 const st=await fs.lstat(absolute);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>2097152)fail('unsupported_path');
 const handle=await fs.open(absolute,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{
  if(statKey(await handle.stat())!==statKey(st))fail('stale_current');
  const nativeId=/^([0-9a-f]{8}):([0-9a-f]{16})$/i.exec(observation?.file?.id??''),opened=await handle.stat({bigint:true});
  if(!nativeId||BigInt('0x'+nativeId[1])!==opened.dev||BigInt('0x'+nativeId[2])!==opened.ino)fail('object_identity_changed');
  const buffer=Buffer.alloc(st.size+1);let offset=0;while(offset<buffer.length){const r=await handle.read(buffer,offset,buffer.length-offset,offset);if(!r.bytesRead)break;offset+=r.bytesRead;}
  const bytes=buffer.subarray(0,offset),last=await fs.lstat(absolute),afterBig=await handle.stat({bigint:true}),linkedBig=await fs.lstat(absolute,{bigint:true});
  if(afterBig.dev!==opened.dev||afterBig.ino!==opened.ino||linkedBig.dev!==opened.dev||linkedBig.ino!==opened.ino)fail('object_identity_changed');
  if(offset!==st.size||statKey(await handle.stat())!==statKey(st)||statKey(last)!==statKey(st)||last.isSymbolicLink()||objectHash(bytes)!==observation.file.digest||bytes.length!==observation.file.bytes)fail('stale_current');
  return {bytes,observation};
 }finally{await handle.close();}
}

// Deliberately unexported. Only the repository's fresh-TEMP harness adds a private
// export in memory. Production construction above cannot reach this execution graph.
function createObjectServiceCore({store,withAuthority,withMutationAuthority,capability,qualify,openAttempt,inspect=inspectOriginal,compute=runSessionRevert,now=Date.now,ttlMs=60000}={}){
 if(!store||typeof withAuthority!=='function'||typeof withMutationAuthority!=='function'||!capability||typeof qualify!=='function'||typeof openAttempt!=='function'||!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>60000)fail('isolated_authority_required');
 const leases=new Map(),inflight=new Map(),preparing=new Set();let disposed=false;
 const data=async()=>typeof store==='function'?store():store;
 const options=expectedRevision=>({capability,expectedRevision});
 const publicPlan=(p,token,diff)=>({ok:true,providerId:p.providerId,profileId:p.profileId,helperHash:p.helperHash,proofId:p.proofId,planId:p.planId,kind:p.kind,revision:p.revision,expiresAt:p.expiresAt,backupReady:true,riskNoticeVersion:2,nonAtomic:true,files:[{fileId:p.files[0].fileId,relativePath:p.files[0].relativePath,state:p.state,diff}],...(token?{confirmationToken:token}:{})});
 const publicResult=(p,durable=true)=>({ok:p.state==='applied_verified',planId:p.planId,requestId:p.requestId,completion:p.state,durable,recoveryAvailable:true,retryAllowed:false,nonAtomic:true});
 async function revision(s,scope,expected){const r=await s.previewRevision(scope);if(r.revision!==expected||r.gapRevision!==0)fail('stale_evidence');}
 async function get(s,a,planId){if(!id(planId))fail('invalid_request');const p=await s.objectGet(a.scope,planId,options());if(!p||!sameObjectScope(p.scope,a.scope))fail('stale_runtime');return validateObjectPlan(p);}
 async function finish(planId){const owned=leases.get(planId);if(!owned)return;clearTimeout(owned.timer);leases.delete(planId);try{await owned.store.restoreRecoveryRelease(owned.scope,planId);}finally{owned.lease.release();}}
 async function update(s,a,p,state,extra={}){
  const next={...p.files[0],state,...(extra.file??{})};const patch={state,completion:state,files:[next],...(extra.requestId!==undefined?{requestId:extra.requestId}:{})};
  return s.objectUpdate(a.scope,p.planId,patch,options(p.revision));
 }
 async function expire(planId){const owned=leases.get(planId);if(!owned||inflight.has(planId))return;try{const p=await owned.store.objectGet(owned.scope,planId,options());if(p?.state==='prepared')await update(owned.store,{scope:owned.scope},p,'not_applied',{file:{failureCode:'plan_expired'}});}catch{}finally{await finish(planId);}}
 function retain(p,a,s){const timer=setTimeout(()=>{void expire(p.planId);},ttlMs);timer.unref?.();leases.set(p.planId,{lease:a.lease,scope:a.scope,store:s,timer});}
 async function qualification(a,evidence,current){
  const checked=evaluateObjectProfile({evidence,current:{...current,scope:a.scope,gapRevision:0},platformProof:READONLY_OBJECT_PROOF,helperHash:OBJECT_HELPER_HASH});
  if(checked.qualification.reason!=='production_allowlist_empty')fail(checked.qualification.reason);
  const proof=await qualify({authority:a,evidence,current:{...current,scope:a.scope,gapRevision:0},scope:a.scope});
  if(!exact(proof,['proofId','helperHash'])||proof.proofId!=='p33-d2-isolated'||proof.helperHash!==OBJECT_WRITER_HASH)fail('object_proof_mismatch');return proof;
 }
 async function assertNoUncertain(s,a,relative,ignorePlanIds=[]){
  if(await s.objectFileBlocked(a.scope,relative,{...options(),ignorePlanIds}))fail('recovery_required');
 }
 async function sourceEvidence(s,a,source){
  let p=source;const lineage=[];for(let i=0;i<16;i++){lineage.push(p.planId);if(p.kind==='revert'){const snap=await s.previewSnapshot(a.scope,{evidenceIds:p.selectedOperationIds,maxOperations:128});return {records:snap.records.filter(r=>p.selectedOperationIds.includes(r.operationId)),original:p,lineage};}p=await get(s,a,p.sourcePlanId);}fail('recovery_unavailable');
 }
 async function prepareOnce(req,body,recovery){
  const allowed=['owner','conversationId','evidenceRevision',...(recovery?['sourcePlanId']:['evidenceIds','fileId'])];
  if(disposed||!closed(body,allowed)||!Number.isSafeInteger(body.evidenceRevision)||body.evidenceRevision<0||(!recovery&&(!Array.isArray(body.evidenceIds)||!body.evidenceIds.length||body.evidenceIds.length>128||!body.evidenceIds.every(id)||new Set(body.evidenceIds).size!==body.evidenceIds.length||!id(body.fileId)))||recovery&&!id(body.sourcePlanId))fail('invalid_request');
  if(leases.size>=32)fail('preview_busy');
  return withMutationAuthority(req,body,async raw=>{
   const a={...raw,scope:normalizedScope(raw.scope)},s=await data();let planId=null,reserved=false,created=null;
   try{
    if(a.activeWriter!==false)fail('active_writer');a.lease.assertCurrent(a.root);await a.revalidate();await revision(s,a.scope,body.evidenceRevision);
    let records,qualifiedRecords,selected,relative,candidate,source=null,current,lineage=[];
    if(recovery){
     source=await get(s,a,body.sourcePlanId);if(source.state!=='recovery_required')fail('recovery_unavailable');relative=source.files[0].relativePath;
     const origin=await sourceEvidence(s,a,source);records=origin.records;qualifiedRecords=records;lineage=origin.lineage;selected=[];current=await inspect(a,relative,records[0]?.operationId);candidate=await s.restoreRead(a.scope,origin.original.files[0].currentRef);
     if(!metadataEqual(source.files[0].currentObject,current.observation))fail('object_metadata_changed');
    }else{
     const snapshot=await s.previewSnapshot(a.scope,{evidenceIds:body.evidenceIds,maxOperations:128});if(snapshot.revision!==body.evidenceRevision)fail('stale_evidence');if(snapshot.gapRevision!==0)fail('attribution_gap');
     records=snapshot.records;selected=snapshot.selectedOperationIds;
     if(new Set(records.map(r=>r.path)).size!==1)fail('single_file_required');relative=records[0]?.path;
     if(objectFileId(a.scope,relative)!==body.fileId)fail('invalid_selection');await assertNoUncertain(s,a,relative);
     const chosen=records.filter(r=>selected.includes(r.operationId));
     if(chosen.length!==selected.length||chosen.some(r=>!Number.isSafeInteger(r.workspaceSequence)||r.workspaceSequence<1))fail('incomplete_evidence');
     const firstSelected=chosen.reduce((first,r)=>!first||r.workspaceSequence<first.workspaceSequence?r:first,null),earliest=firstSelected.workspaceSequence;
     qualifiedRecords=records.filter(r=>r.workspaceSequence>=earliest);current=await inspect(a,relative,firstSelected.operationId);
     const result=await compute({records,selectedOperationIds:selected,current:current.bytes,gapRevision:0,now:now()});
     if(result.status!=='candidate'||result.contentEligible!==true||result.action!=='replace'||!Buffer.isBuffer(result.candidate))fail(result.reason||'unsupported_operation');candidate=result.candidate;
     // P33.3 receives the complete ordered history. Eligibility follows its
     // earliest selected sequence, so an older already-consumed transaction
     // cannot disqualify a later independent operation on the same file.
    }
    if(!qualifiedRecords.length||qualifiedRecords.some(r=>!sameObjectScope(r.scope,a.scope)||r.evidenceLevel!=='intent_verified'||r.state!=='observed'||r.toolResultObserved!==true||r.attributionGapRevision!==0||r.consumed===true||!r.beforeRef))fail('incomplete_evidence');
    await assertNoUncertain(s,a,relative,lineage);
    let proof;for(const record of qualifiedRecords){const observation={...current.observation,binding:{...current.observation.binding,operationId:record.operationId}};proof=await qualification(a,record,{bytes:current.bytes,observation});}
    if(current.bytes.length>2097152||candidate.length>2097152)fail('object_budget_exceeded');
    const view=boundedRevertDiff(current.bytes,candidate);if(view.diffUnavailable)fail('diff_budget_exceeded');
    await a.revalidate();await revision(s,a.scope,body.evidenceRevision);
    planId=randomUUID();await s.restoreRecoveryReserve(a.scope,planId,262144);reserved=true;
    const currentRef=await s.restorePut(a.scope,current.bytes),candidateRef=await s.restorePut(a.scope,candidate);const expected=body.evidenceRevision+2;
    const C=await s.restoreRead(a.scope,currentRef),R=await s.restoreRead(a.scope,candidateRef);await s.restoreDescriptor(a.scope,currentRef);await s.restoreDescriptor(a.scope,candidateRef);
    if(!C.equals(current.bytes)||!R.equals(candidate))fail('backup_invalid');
    const fresh=await inspect(a,relative,current.observation.binding.operationId);if(!fresh.bytes.equals(current.bytes)||!metadataEqual(current.observation,fresh.observation))fail('stale_current');
    await a.revalidate();await revision(s,a.scope,expected);a.lease.assertCurrent(a.root);if(disposed)fail('service_disposed');
    const token=randomBytes(32).toString('hex'),at=now();
    const plan={schemaVersion:1,providerId:OBJECT_PROVIDER_ID,profileId:OBJECT_PROFILE_ID,helperHash:OBJECT_WRITER_HASH,proofId:proof.proofId,riskNoticeVersion:OBJECT_RISK_VERSION,
     planId,tokenHash:objectHash(token),requestId:null,scope:a.scope,kind:recovery?'recover':'revert',sourcePlanId:source?.planId??null,selectedOperationIds:selected,consumedOperationIds:[],
     evidenceRevision:body.evidenceRevision,revision:expected+1,gapRevision:0,expiresAt:at+ttlMs,createdAt:at,updatedAt:at,state:'prepared',completion:'prepared',
     files:[{fileId:objectFileId(a.scope,relative),relativePath:relative,action:'write_original',operationIds:selected,currentRef,candidateRef,currentObject:current.observation,state:'prepared',intent:null,observedPostDigest:null,verifiedMeasurement:null,failureCode:null}]};
    created=await s.objectCreate(a.scope,validateObjectPlan(plan),options(expected));await revision(s,a.scope,created.revision);await a.revalidate();a.lease.assertCurrent(a.root);if(disposed)fail('service_disposed');
    retain(created,a,s);return publicPlan(created,token,view.diff);
   }catch(e){if(created)try{await update(s,a,created,'not_applied',{file:{failureCode:safeError(e)}});}catch{}if(reserved)try{await s.restoreRecoveryRelease(a.scope,planId);}catch{}a.lease.release();throw e;}
  });
 }
 function confirm(body,p){
  if(!closed(body,['owner','conversationId','providerId','profileId','helperHash','proofId','planId','confirmationToken','requestId','riskNoticeVersion','confirmation'])||body.providerId!==p.providerId||body.profileId!==p.profileId||body.helperHash!==p.helperHash||body.proofId!==p.proofId||body.riskNoticeVersion!==p.riskNoticeVersion||!id(body.requestId)||typeof body.confirmationToken!=='string'||!/^[0-9a-f]{64}$/.test(body.confirmationToken)||!exact(body.confirmation,['externalWritersPaused','partialWriteRiskAccepted'])||body.confirmation.externalWritersPaused!==true||body.confirmation.partialWriteRiskAccepted!==true)fail('confirmation_required');
  if(!timingSafeEqual(Buffer.from(objectHash(body.confirmationToken),'hex'),Buffer.from(p.tokenHash,'hex')))fail('confirmation_required');
 }
 async function applyOnce(req,body){
  let owned;
  const initial=await withAuthority(req,body,async a=>{const s=await data(),p=await get(s,a,body.planId);confirm(body,p);if(p.requestId){if(p.requestId!==body.requestId)fail('plan_consumed');return {result:publicResult(p)};}if(p.state!=='prepared')fail('plan_consumed');if(disposed||now()>=p.expiresAt){try{await update(s,a,p,'not_applied',{file:{failureCode:'plan_expired'}});}finally{await finish(p.planId);}fail('plan_expired');}if(!leases.has(p.planId))fail('plan_expired');return {plan:p};});
  if(initial.result)return initial.result;owned=leases.get(body.planId);clearTimeout(owned.timer);owned.lease.pinForApply();
  try{return await withMutationAuthority(req,body,async raw=>{
   const a={...raw,scope:normalizedScope(raw.scope)},s=await data();let p=await get(s,a,body.planId),attempt=null,intent=false;
   try{
    confirm(body,p);if(p.state!=='prepared'||now()>=p.expiresAt)fail('plan_expired');await a.revalidate();a.lease.assertCurrent(a.root);await revision(s,a.scope,p.revision);
    const f=p.files[0],C=await s.restoreRead(a.scope,f.currentRef),R=await s.restoreRead(a.scope,f.candidateRef),current=await inspect(a,f.relativePath,f.currentObject.binding.operationId);
    if(!C.equals(current.bytes)||!metadataEqual(f.currentObject,current.observation))fail('stale_current');
    await s.restoreRecoveryCheck(a.scope,p.planId);await s.restoreDescriptor(a.scope,f.currentRef);await s.restoreDescriptor(a.scope,f.candidateRef);
    const nativeAuthority=Object.freeze({root:a.root,scope:a.scope,planId:p.planId,intentRevision:1});
    attempt=await openAttempt({authority:nativeAuthority,relativePath:f.relativePath,currentRef:f.currentRef,candidateRef:f.candidateRef,expectedObject:f.currentObject,proofId:p.proofId});
    if(attempt.helperHash!==p.helperHash||attempt.ready?.digest!==f.currentRef.digest||attempt.ready?.id!==f.currentObject.file.id)fail('native_not_ready');
    await a.revalidate();a.lease.assertCurrent(a.root);await revision(s,a.scope,p.revision);
    const record={attemptId:attempt.attemptId,bindingDigest:attempt.bindingDigest,nativeIntentRevision:1,journalRevision:p.revision+1,helperHash:p.helperHash,requestId:body.requestId,readyDigest:f.currentRef.digest,readyObjectId:f.currentObject.file.id,confirmedAt:now()};
    // An append/readback failure can leave a durable intent even without a reply.
    // Classify that uncertainty conservatively; never send commit on such failure.
    intent=true;p=await update(s,a,p,'replacing',{requestId:body.requestId,file:{intent:record}});
    await a.revalidate();a.lease.assertCurrent(a.root);await revision(s,a.scope,p.revision);await s.restoreRecoveryCheck(a.scope,p.planId);
    const result=await attempt.commit({planId:p.planId,attemptId:attempt.attemptId,intentRevision:1,bindingDigest:attempt.bindingDigest});
    await attempt.close();
    if(result?.status!=='verified'||result.measurement?.digest!==objectHash(R)||result.measurement?.bytes!==R.length||result.measurement?.id!==f.currentObject.file.id||result.measurement?.metadataEqual!==true)fail('native_unconfirmed');
    const after=await inspect(a,f.relativePath,f.currentObject.binding.operationId);
    if(!after.bytes.equals(R)||!metadataEqual(f.currentObject,after.observation))fail('native_unconfirmed');
    await a.revalidate();a.lease.assertCurrent(a.root);await revision(s,a.scope,p.revision);
    p=await update(s,a,p,'applied_verified',{file:{observedPostDigest:objectHash(R),verifiedMeasurement:result.measurement}});return publicResult(p);
   }catch(e){
    const state=intent?'recovery_required':'not_applied';
    try{const latest=await s.objectGet(a.scope,p.planId,options());if(latest?.state==='applied_verified')return publicResult(latest);if(latest&&['prepared','replacing'].includes(latest.state))p=await update(s,a,latest,state,{...(intent?{requestId:body.requestId}:{}),file:{failureCode:safeError(e)}});return publicResult(p);}
    catch{return {ok:false,planId:p.planId,requestId:body.requestId,completion:state,durable:false,recoveryAvailable:true,retryAllowed:false,nonAtomic:true,reason:'evidence_storage_failed'};}
   }finally{if(attempt)await attempt.close();}
  },{lease:owned.lease});}finally{await finish(body.planId);}
 }
 async function apply(req,body){
  if(!id(body?.planId)||!id(body?.requestId))fail('invalid_request');
  if(inflight.has(body.planId)){const running=inflight.get(body.planId);await withAuthority(req,body,async a=>{const p=await get(await data(),a,body.planId);confirm(body,p);if(p.requestId&&p.requestId!==body.requestId)fail('plan_consumed');});if(running.requestId!==body.requestId)fail('plan_consumed');return running.task;}
  const task=applyOnce(req,body);inflight.set(body.planId,{requestId:body.requestId,task});try{return await task;}finally{inflight.delete(body.planId);}
 }
 async function cancel(req,body){if(!closed(body,['owner','conversationId','planId']))fail('invalid_request');return withAuthority(req,body,async a=>{const s=await data(),p=await get(s,a,body.planId);if(inflight.has(p.planId)||p.state!=='prepared')fail('plan_consumed');const result=await update(s,a,p,'not_applied',{file:{failureCode:'cancelled'}});await finish(p.planId);return publicResult(result);});}
 async function inspectRecovery(req,body){if(!closed(body,['owner','conversationId','planId']))fail('invalid_request');return withAuthority(req,body,async a=>{const s=await data(),p=await get(s,a,body.planId),f=p.files[0];await s.restoreRead(a.scope,f.currentRef);await s.restoreRead(a.scope,f.candidateRef);await a.revalidate();return {...publicResult(p),revision:(await s.previewRevision(a.scope)).revision,readOnly:true};});}
 async function exportMaterial(req,body){if(!closed(body,['owner','conversationId','planId','material'])||!['current','candidate'].includes(body.material))fail('invalid_request');return withAuthority(req,body,async a=>{const s=await data(),p=await get(s,a,body.planId),ref=p.files[0][body.material+'Ref'],bytes=await s.restoreRead(a.scope,ref);await a.revalidate();return {bytes,digest:ref.digest,readOnly:true,applyEligible:false};});}
 function prepare(req,body,recovery){const task=prepareOnce(req,body,recovery);preparing.add(task);return task.finally(()=>preparing.delete(task));}
 return Object.freeze({prepareObjectRevert:(req,body)=>prepare(req,body,false),prepareObjectRecovery:(req,body)=>prepare(req,body,true),applyObjectRevert:apply,cancelObjectRevert:cancel,inspectObjectRecovery:inspectRecovery,exportVerifiedRecoveryMaterial:exportMaterial,
  async dispose(){disposed=true;await Promise.allSettled([...preparing,...[...inflight.values()].map(v=>v.task)]);await Promise.allSettled([...leases.keys()].map(expire));}});
}
