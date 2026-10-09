import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { runSessionRevert } from './session-revert-compute.js';
import { createSessionRevertWriter } from './session-revert-writer.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(Error(code), {code}); };
const id = v => typeof v==='string' && /^[a-zA-Z0-9_-]{1,256}$/.test(v);
const ids = v => Array.isArray(v) && v.length>0 && v.length<=32 && v.every(id) && new Set(v).size===v.length;
const equal = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const persistent = s => ['projectId','repoId','workspaceId','workspaceEpoch','conversationId','nativeSessionId','workspaceFingerprint'].map(k=>s[k]??s.runtimeOwner?.[k]??null);
const ownerFields=['backendInstance','projectId','repoId','workspaceId','workspaceEpoch','conversationId','runtimeId','runtimeGeneration','sessionId'];
const scopeSame = (a,b) => equal(persistent(a),persistent(b)) && equal(a.runtimeOwner?ownerFields.map(k=>a.runtimeOwner[k]):null,b.runtimeOwner?ownerFields.map(k=>b.runtimeOwner[k]):null);
export const revertFileId = (scope,relativePath) => hash(JSON.stringify([persistent(scope).slice(0,4),relativePath]));
export const REVERT_RISK_NOTICE = Object.freeze({version:1,mode:'confirmed_limited',retentionDays:7,
  instructions:['save_and_pause_external_writers','git_index_unchanged','backup_precedes_replacement',
    'external_race_after_final_check_possible','late_external_changes_may_not_be_in_backup','no_batch_atomicity','open_handles_may_keep_writing_moved_files']});

/** Private plan service. No raw contents or references are returned except explicit export/diff. */
export function createSessionRevertService({store,withAuthority,withMutationAuthority,writer=createSessionRevertWriter(),
  compute=runSessionRevert,now=Date.now,ttlMs=60000}={}) {
  if (!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>60000) throw Error('invalid plan lifetime');
  const leases=new Map(), inflight=new Map();
  const data = async()=>typeof store==='function'?store():store;
  const finishLease = planId => {const owned=leases.get(planId);if(owned){clearTimeout(owned.timer);owned.lease.release();leases.delete(planId);}};
  const retain = (planId,lease)=>{
    const timer=setTimeout(()=>finishLease(planId),ttlMs);timer.unref?.();leases.set(planId,{lease,timer});
  };
  const publicPlan = plan=>({ok:true,planId:plan.planId,mode:plan.mode,expiresAt:plan.expiresAt,revision:plan.revision,gapRevision:plan.gapRevision,
    target:{conversationId:plan.scope.conversationId,workspaceId:plan.scope.workspaceId,workspaceEpoch:plan.scope.workspaceEpoch},
    files:plan.files.map(f=>({fileId:f.fileId,relativePath:f.relativePath,action:f.action,state:f.state,operationIds:f.operationIds})),
    backupReady:true,riskNotice:REVERT_RISK_NOTICE,residualRacePossible:true});
  const publicResult = plan=>({ok:true,planId:plan.planId,requestId:plan.requestId,completion:plan.completion,residualRacePossible:true,
    files:plan.files.map(f=>({fileId:f.fileId,relativePath:f.relativePath,state:f.state,reason:f.reason??null,operationIds:f.operationIds})),
    recoveryAvailable:plan.files.some(f=>f.currentRef!==null),retentionDays:7});
  async function revisionCheck(s,scope,expected,gap){const actual=await s.previewRevision(scope);if(actual.revision!==expected||actual.gapRevision!==gap)fail('stale_evidence');}
  async function inspectFile(authority,relativePath){const value=await writer.inspect(authority.root,relativePath);return value;}
  function metadataCheck(before,after,current,created=false){
    if([before,after,current].some(m=>m?.reason==='metadata_audit_unavailable'))fail('metadata_audit_unavailable');
    if ((!created&&before?.supported!==true)||after?.supported!==true||current?.supported!==true)fail('metadata_unsupported');
    if ((!created&&!equal(before,after))||!equal(after,current))fail('metadata_changed');
  }
  async function authorizedPlan(s,authority,planId,{historical=false}={}){
    if(!id(planId))fail('invalid_request');const plan=await s.applyGet(authority.scope,planId);
    if(!plan||!(historical?equal(persistent(plan.scope),persistent(authority.scope)):scopeSame(plan.scope,authority.scope)))fail('stale_runtime');return plan;
  }
  async function prepare(req,body){
    if(body.mode==='strict')fail('exclusive_provider_unavailable');
    if(body.mode!=='confirmed_limited'||!ids(body.selectedFileIds)||!Number.isSafeInteger(body.evidenceRevision)||body.evidenceRevision<0)fail('invalid_request');
    if(!withMutationAuthority)fail('writer_unavailable');
    const recovery=body.sourcePlanId!==undefined;
    if(!recovery&&(!Array.isArray(body.evidenceIds)||!body.evidenceIds.length||body.evidenceIds.length>128||!body.evidenceIds.every(id)||new Set(body.evidenceIds).size!==body.evidenceIds.length))fail('invalid_request');
    return withMutationAuthority(req,body,async authority=>{
      const s=await data(),scope=authority.scope,lease=authority.lease;
      try {
        lease.assertCurrent(authority.root);if(authority.activeWriter!==false)fail('active_writer');await authority.revalidate?.();
        let expected=body.evidenceRevision, gap, work=[];
        if(recovery){
          const source=await authorizedPlan(s,authority,body.sourcePlanId,{historical:true}),r=await s.previewRevision(scope);gap=r.gapRevision;
          if(r.revision!==expected)fail('stale_evidence');
          for(const fileId of body.selectedFileIds){
            const original=source.files.find(f=>f.fileId===fileId);if(!original?.currentRef)fail('recovery_unavailable');
            const current=await inspectFile(authority,original.relativePath),candidate=await s.restoreRead(scope,original.currentRef);
            if(original.action==='move_to_recovery'&&current.bytes!==null)fail('destination_exists');
            if(current.bytes!==null)metadataCheck(original.currentMetadata,original.currentMetadata,current.metadata);
            else if(original.action!=='move_to_recovery'||!original.recoveryPath)fail('current_missing');
            work.push({fileId,relativePath:original.relativePath,operationIds:[],current,candidate,
              action:current.bytes===null?'restore_moved':'replace',recoveryPath:original.recoveryPath??null,recoveryMetadata:original.recoveryMetadata??null,restoredMetadata:original.currentMetadata});
          }
        }else{
          const snapshot=await s.previewSnapshot(scope,{evidenceIds:body.evidenceIds,maxOperations:128});gap=snapshot.gapRevision;
          if(snapshot.revision!==expected)fail('stale_evidence');if(gap!==0)fail('attribution_gap');
          const selected=new Set(snapshot.selectedOperationIds),paths=new Map();
          for(const record of snapshot.records){if(!paths.has(record.path))paths.set(record.path,[]);paths.get(record.path).push(record);}
          const requested=new Set(body.selectedFileIds);
          for(const [relativePath,records]of paths){
            const fileId=revertFileId(scope,relativePath);if(!requested.has(fileId))continue;requested.delete(fileId);
            const chosen=records.filter(r=>selected.has(r.operationId));if(!chosen.length)fail('invalid_selection');
            if(records.some(r=>r.consumed))fail('already_reverted');
            const current=await inspectFile(authority,relativePath);
            if(current.bytes===null)fail('current_missing');
            const result=await compute({records,selectedOperationIds:chosen.map(r=>r.operationId),current:current.bytes,gapRevision:gap,now:now()});
            if(result.status!=='candidate'||result.contentEligible!==true)fail(result.reason||'already_reverted');
            for(const record of records.filter(r=>r.workspaceSequence>=chosen[0].workspaceSequence))
              metadataCheck(record.beforeMetadata,record.afterMetadata,current.metadata,record.before===null);
            work.push({fileId,relativePath,operationIds:chosen.map(r=>r.operationId),current,candidate:result.candidate,action:result.action});
          }
          if(requested.size||work.length!==body.selectedFileIds.length)fail('invalid_selection');
        }
        // Every file must qualify before any plan can become confirmable.
        await authority.revalidate?.();await revisionCheck(s,scope,expected,gap);
        const files=[],diffs=new Map();let diffBudget=32768;
        for(const item of work){
          lease.assertCurrent(authority.root);
          const view=boundedRevertDiff(item.current.bytes,item.candidate,diffBudget);
          if(view.diffUnavailable)fail('diff_budget_exceeded');diffBudget-=Buffer.byteLength(view.diff);diffs.set(item.fileId,view.diff);
        }
        for(const item of work){
          if(item.current.bytes!==null&&item.current.metadata?.supported!==true)fail('metadata_unsupported');
          const currentRef=await s.restorePut(scope,item.current.bytes);if(currentRef!==null)expected++;
          const candidateRef=await s.restorePut(scope,item.candidate);if(candidateRef!==null)expected++;
          await revisionCheck(s,scope,expected,gap);
          const fresh=await inspectFile(authority,item.relativePath);if(fresh.fingerprint!==item.current.fingerprint)fail('stale_current');
          files.push({fileId:item.fileId,relativePath:item.relativePath,operationIds:item.operationIds,currentRef,candidateRef,
            currentMetadata:item.current.metadata,currentFingerprint:item.current.fingerprint,parentIdentity:item.current.parentIdentity,
            action:item.action,state:'prepared',observedPostDigest:null,recoveryPath:item.recoveryPath??null,recoveryMetadata:item.recoveryMetadata??null,restoredMetadata:item.restoredMetadata??null});
        }
        await authority.revalidate?.();await revisionCheck(s,scope,expected,gap);lease.assertCurrent(authority.root);
        const planId=randomUUID(),token=randomBytes(32).toString('hex'),createdAt=now();
        const plan={planId,requestId:null,scope,mode:body.mode,kind:recovery?'recover':'revert',sourcePlanId:body.sourcePlanId??null,
          selectedOperationIds:files.flatMap(f=>f.operationIds),selectedFileIds:[...body.selectedFileIds],files,
          revision:expected+1,gapRevision:gap,riskNoticeVersion:1,expiresAt:createdAt+ttlMs,createdAt,
          tokenHash:hash(token),confirmationAt:null,completion:'prepared',residualRacePossible:true};
        await s.applyCreate(scope,plan);expected++;
        await revisionCheck(s,scope,expected,gap);await authority.revalidate?.();lease.assertCurrent(authority.root);
        retain(planId,lease);const response=publicPlan(plan);
        for(const file of response.files)file.diff=diffs.get(file.fileId);
        return {...response,confirmationToken:token};
      }catch(e){lease.release();throw e;}
    });
  }
  function validConfirmation(body,plan){
    const c=body.confirmation;
    return body.mode===plan.mode&&ids(body.selectedFileIds)&&equal([...body.selectedFileIds].sort(),[...plan.selectedFileIds].sort())
      &&c&&Object.keys(c).sort().join(',')==='externalWritersPaused,lastCheckRaceAccepted,riskNoticeVersion'
      &&c.externalWritersPaused===true&&c.lastCheckRaceAccepted===true&&c.riskNoticeVersion===plan.riskNoticeVersion;
  }
  async function apply(req,body){
    if(!id(body.planId)||!id(body.requestId)||typeof body.confirmationToken!=='string'||!/^[0-9a-f]{64}$/.test(body.confirmationToken))fail('invalid_request');
    // Duplicate transport requests share the same in-flight task; no second write.
    const key=body.planId+':'+body.requestId;
    if(inflight.has(key)){
      const running=inflight.get(key);
      await withAuthority(req,body,async authority=>{const s=await data(),plan=await authorizedPlan(s,authority,body.planId);if(!validConfirmation(body,plan)||hash(body.confirmationToken)!==plan.tokenHash)fail('confirmation_required');});
      return running;
    }
    const task=applyOnce(req,body);inflight.set(key,task);try{return await task;}finally{inflight.delete(key);}
  }
  async function applyOnce(req,body){
    const initial=await withAuthority(req,body,async authority=>{
      const s=await data(),plan=await authorizedPlan(s,authority,body.planId);
      if(!validConfirmation(body,plan))fail('confirmation_required');
      const supplied=Buffer.from(hash(body.confirmationToken),'hex'),expected=Buffer.from(plan.tokenHash,'hex');
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))fail('confirmation_required');
      if(plan.requestId){if(plan.requestId!==body.requestId)fail('plan_consumed');return {result:publicResult(plan)};}
      if(plan.completion!=='prepared')fail('plan_consumed');if(now()>=plan.expiresAt)fail('plan_expired');
      if(!leases.has(plan.planId))fail('plan_expired');return {plan};
    });
    if(initial.result)return initial.result;
    const owned=leases.get(body.planId);owned.lease.pinForApply();clearTimeout(owned.timer);
    try{return await withMutationAuthority(req,body,async authority=>{
      const s=await data(),plan=await authorizedPlan(s,authority,body.planId),scope=authority.scope;let expected=plan.revision;
      if(plan.requestId||plan.completion!=='prepared'||now()>=plan.expiresAt)fail('plan_expired');
      await authority.revalidate?.();await revisionCheck(s,scope,expected,plan.gapRevision);
      const materials=[];
      // Preflight EVERY target before recording confirmation/committing any file.
      for(const file of plan.files){
        const current=await inspectFile(authority,file.relativePath);
        if(current.fingerprint!==file.currentFingerprint)fail('stale_current');
        if(current.bytes!==null&&!equal(current.metadata,file.currentMetadata))fail('metadata_changed');
        const backup=await s.restoreRead(scope,file.currentRef),candidate=await s.restoreRead(scope,file.candidateRef);
        if((backup===null)!==(current.bytes===null)||(backup!==null&&!backup.equals(current.bytes)))fail('backup_invalid');
        materials.push({backup,candidate});
      }
      const persist=async patch=>{Object.assign(plan,patch);await s.applyUpdate(scope,plan.planId,patch);expected++;await revisionCheck(s,scope,expected,plan.gapRevision);};
      await persist({requestId:body.requestId,confirmationAt:now(),completion:'applying'});
      for(let i=0;i<plan.files.length;i++){
        const file=plan.files[i];let intent=false;
        try{
          const result=await writer.apply({root:authority.root,relativePath:file.relativePath,currentFingerprint:file.currentFingerprint,
            currentMetadata:file.currentMetadata,candidate:materials[i].candidate,action:file.action,backupVerified:true,
            recoveryPath:file.recoveryPath,recoveryMetadata:file.recoveryMetadata,restoredMetadata:file.restoredMetadata,
            ...(['restore_moved','move_to_recovery'].includes(file.action)?{recoveryRoot:await writer.ensureRecoveryRoot(authority.root,await s.restoreRecoveryRoot(scope)),recoveryRootVerified:true}:{}),
            stateCheck:async()=>{authority.lease.assertCurrent(authority.root);await authority.revalidate?.();await revisionCheck(s,scope,expected,plan.gapRevision);},
            recordState:async (state,details={})=>{
              const value=typeof state==='string'?{state,...details}:state;
              if(!['replacing','moving','applied_verified'].includes(value.state))fail('invalid_writer_state');intent=true;
              if(value.state==='applied_verified'){
                value.observedPostDigest=file.action==='move_to_recovery'?null:value.digest;
                delete value.digest;
              }
              Object.assign(file,value);await persist({files:plan.files});
            }});
          if(result?.state==='recovery_required'||result?.ok===false)throw Object.assign(Error('writer_failed'),{code:result.reason||'write_failed',recoveryRequired:true});
          if(file.state!=='applied_verified')throw Object.assign(Error('unverified writer result'),{code:'post_verification_failed',recoveryRequired:true});
        }catch(e){
          file.state=intent||e.recoveryRequired?'recovery_required':'not_applied';file.reason=safeRevertCode(e);
          for(const remaining of plan.files.slice(i+1))remaining.state='not_applied';
          const completion=plan.files.some(f=>f.state==='applied_verified')?'partial':file.state==='recovery_required'?'recovery_required':'refused';
          try{await persist({files:plan.files,completion});}catch{fail('apply_journal_failed');}
          return publicResult(plan);
        }
      }
      await persist({completion:'completed',files:plan.files});return publicResult(plan);
    },{lease:owned.lease});}finally{finishLease(body.planId);}
  }
  async function cancel(req,body){return withAuthority(req,body,async authority=>{
    const s=await data(),plan=await authorizedPlan(s,authority,body.planId);
    if(plan.requestId||inflight.has(plan.planId+':'+body.requestId))fail('plan_consumed');
    if(plan.completion==='prepared')await s.applyUpdate(authority.scope,plan.planId,{completion:'cancelled',files:plan.files.map(f=>({...f,state:'not_applied'}))});
    finishLease(plan.planId);return {ok:true,planId:plan.planId,completion:'cancelled'};
  });}
  async function recoverPreview(req,body){return withAuthority(req,body,async authority=>{
    const s=await data();
    if(body.sourcePlanId===undefined){const plans=await s.applyList(authority.scope);await authority.revalidate?.();return {ok:true,plans:plans.slice(-64).reverse().map(plan=>({planId:plan.planId,completion:plan.completion,state:plan.state,
      createdAt:plan.createdAt,files:plan.files.map(f=>({fileId:f.fileId,relativePath:f.relativePath,state:f.state,backupAvailable:f.currentRef!==null}))})),backupReady:false,residualRacePossible:true};}
    const plan=await authorizedPlan(s,authority,body.sourcePlanId,{historical:true});if(!ids(body.selectedFileIds))fail('invalid_request');
    const files=[];
    for(const fileId of body.selectedFileIds){const file=plan.files.find(f=>f.fileId===fileId);if(!file?.currentRef)fail('recovery_unavailable');
      const current=await inspectFile(authority,file.relativePath),backup=await s.restoreRead(authority.scope,file.currentRef),candidate=await s.restoreRead(authority.scope,file.candidateRef);
      files.push({fileId,relativePath:file.relativePath,currentBytes:current.bytes?.length??null,restoreBytes:backup.length,
        state:current.bytes?.equals(backup)?'already_reverted':'candidate',needsPrepare:true,
        observedMatches:current.bytes?.equals(backup)?'preimage':current.bytes===null?(candidate===null?'candidate':'absent'):candidate!==null&&current.bytes.equals(candidate)?'candidate':'other',
        priorState:file.state,uncertainHistory:plan.state==='recovery_required',
        ...(body.includeDiff===true?boundedRevertDiff(current.bytes,backup):{})});
    }
    const revision=await s.previewRevision(authority.scope);await authority.revalidate?.();
    return {ok:true,sourcePlanId:plan.planId,files,revision:revision.revision,backupReady:false,residualRacePossible:true};
  });}
  async function exportMaterial(req,body){return withAuthority(req,body,async authority=>{
    if(!id(body.fileId)||typeof body.exportName!=='string'||!/^[a-zA-Z0-9_.-]{1,120}$/.test(body.exportName)||body.exportName==='.'||body.exportName==='..')fail('invalid_request');
    const s=await data(),plan=await authorizedPlan(s,authority,body.sourcePlanId,{historical:true}),file=plan.files.find(f=>f.fileId===body.fileId);
    if(!file?.currentRef)fail('recovery_unavailable');const bytes=await s.restoreRead(authority.scope,file.currentRef);
    await authority.revalidate?.();return {bytes,name:body.exportName};
  });}
  return {prepare,apply,cancel,recoverPreview,exportMaterial,dispose(){for(const key of leases.keys())finishLease(key);}};
}

// Display-only diff; never accepted as input to a writer.
export function boundedRevertDiff(current,candidate,maxBytes=32768){
  const left=current?.toString('utf8')??'',right=candidate?.toString('utf8')??'';
  if(left===right)return {diff:''};
  const a=left.match(/[^\n]*\n|[^\n]+$/g)||[],b=right.match(/[^\n]*\n|[^\n]+$/g)||[];let start=0,endA=a.length,endB=b.length;
  while(start<endA&&start<endB&&a[start]===b[start])start++;
  while(endA>start&&endB>start&&a[endA-1]===b[endB-1]){endA--;endB--;}
  let diff='--- current\n+++ candidate\n@@ -'+start+','+(endA-start)+' +'+start+','+(endB-start)+' @@\n';
  for(const [prefix,lines]of[['-',a.slice(start,endA)],['+',b.slice(start,endB)]])for(const line of lines){
    if(Buffer.byteLength(diff)+Buffer.byteLength(line)+32>maxBytes)return {diffUnavailable:'diff_budget_exceeded'};
    diff+=prefix+line+(line.endsWith('\n')?'':'\n\\ No newline at end of file\n');
  }return {diff};
}
const SAFE=new Set(['invalid_request','exclusive_provider_unavailable','writer_unavailable','stale_evidence','attribution_gap','metadata_unsupported','metadata_changed',
  'already_reverted','current_missing','invalid_selection','incomplete_evidence','unsupported_text','unsupported_operation','ambiguous_mapping','overlapping_changes',
  'cross_session_conflict','unproven_continuity','expired_evidence','scope_mismatch','diff_budget_exceeded','budget_exceeded','preview_busy','compute_unavailable',
  'stale_current','stale_runtime','stale_workspace','active_writer','plan_expired','confirmation_required','plan_consumed','backup_invalid','recovery_unavailable',
  'evidence_not_found','evidence_integrity_failed','evidence_privacy_unavailable','evidence_storage_failed','evidence_quota_exceeded','apply_journal_failed',
  'unsupported_path','unsupported_platform','metadata_audit_unavailable','metadata_unavailable','write_failed','replacement_failed','post_verification_failed',
  'cross_volume','destination_exists','backup_required','unsupported_filesystem','admission_timeout','recovery_required','backup_unverified',
  'recovery_storage_unavailable','metadata_validation_failed','restore_move_failed','recovery_volume_unsupported','recovery_destination_exists','oversized']);
export const safeRevertCode = error=>SAFE.has(error?.code)?error.code:'revert_unavailable';
