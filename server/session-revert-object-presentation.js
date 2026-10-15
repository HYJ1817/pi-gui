// Display-only projections. This module neither constructs nor opens a Writer.
import { OBJECT_PROVIDER_ID, OBJECT_RISK_VERSION, objectFileId, objectIdentifier, sameObjectScope, objectRelativePath, objectFail as fail } from './session-revert-object-contract.js';
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const size=x=>Number.isSafeInteger(x)&&x>=0&&x<=2097152;
const closed=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).every(k=>keys.includes(k));
export function projectObjectPlan(raw){
 const f=raw?.files?.[0],scope=raw?.scope??raw;
 if(raw?.ok!==true||raw.providerId!==OBJECT_PROVIDER_ID||raw.riskNoticeVersion!==OBJECT_RISK_VERSION||!objectIdentifier(raw.planId)||raw.files?.length!==1||!hex(f?.fileId)
  ||typeof f.relativePath!=='string'||typeof f.diff!=='string'||Buffer.byteLength(f.diff)>32768||!size(raw.currentBytes)||!size(raw.candidateBytes)||!Number.isSafeInteger(raw.expiresAt)||!Number.isSafeInteger(raw.revision)||!['revert','recover'].includes(raw.kind))fail('invalid_projection');
 const objectId=raw.objectId??f.objectId;if(typeof objectId!=='string'||!objectId||objectId.length>256)fail('invalid_projection');
 return {ok:true,planId:raw.planId,providerId:OBJECT_PROVIDER_ID,kind:raw.kind,revision:raw.revision,riskNoticeVersion:OBJECT_RISK_VERSION,
  fileId:f.fileId,objectId,relativePath:f.relativePath,diff:f.diff,currentBytes:raw.currentBytes,candidateBytes:raw.candidateBytes,expiresAt:raw.expiresAt,backupReady:raw.backupReady===true,
  scope:{conversationId:scope.conversationId,workspaceId:scope.workspaceId,workspaceEpoch:scope.workspaceEpoch,workspaceFingerprint:scope.workspaceFingerprint??null,runtimeGeneration:scope.runtimeGeneration}};
}
export function projectObjectResult(raw){
 if(!['not_applied','applied_verified','recovery_required','prepared','replacing'].includes(raw?.completion))fail('invalid_projection');
 const uncertain=raw.durable!==true,completion=uncertain&&['applied_verified','replacing'].includes(raw.completion)?'recovery_required':raw.completion;
 return {ok:raw.ok===true&&completion==='applied_verified'&&!uncertain,planId:raw.planId,completion,durable:raw.durable===true,
  backupReady:raw.backupReady===true,recoveryAvailable:raw.recoveryAvailable===true,retryAllowed:false,objectMaintained:raw.objectMaintained===true&&!uncertain,
  ...(Number.isSafeInteger(raw.revision)?{revision:raw.revision}:{}),...(raw.readOnly===true?{readOnly:true}:{})};
}
export function projectObjectHistory(raw){
 const f=raw?.files?.[0],s=raw?.scope;
 if(raw?.providerId!==OBJECT_PROVIDER_ID||![2,OBJECT_RISK_VERSION].includes(raw.riskNoticeVersion)||!objectIdentifier(raw.planId)||raw.files?.length!==1||!hex(f?.fileId)
  ||!['not_applied','applied_verified','recovery_required','prepared','replacing'].includes(raw.completion))fail('invalid_projection');
 return {planId:raw.planId,providerId:OBJECT_PROVIDER_ID,fileId:f.fileId,objectId:raw.objectId??f.currentObject?.file?.id??f.objectId,
  relativePath:objectRelativePath(f.relativePath),riskNoticeVersion:raw.riskNoticeVersion,completion:raw.completion,createdAt:Number.isSafeInteger(raw.createdAt)?raw.createdAt:0,
  readOnly:true,applyEligible:false,recoveryEligible:false,backupReady:false,
  scope:{conversationId:s?.conversationId,workspaceId:s?.workspaceId,workspaceEpoch:s?.workspaceEpoch,workspaceFingerprint:s?.workspaceFingerprint??null,runtimeGeneration:s?.runtimeOwner?.runtimeGeneration??s?.runtimeGeneration}};
}
export function createSessionRevertObjectHistory({store,withAuthority}={}){
 if(!store||typeof withAuthority!=='function')fail('invalid_projection');
 return async(req,body)=>{
  if(!closed(body,['owner','conversationId'])||body.conversationId!==undefined&&!objectIdentifier(body.conversationId))fail('invalid_request');
  return withAuthority(req,body,async a=>{
   const data=typeof store==='function'?await store():store;
   const plans=(await data.applyList(a.scope)).filter(p=>p.providerId===OBJECT_PROVIDER_ID&&sameObjectScope(p.scope,a.scope));
   await a.revalidate();
   return {ok:true,readOnly:true,applyEligible:false,target:{conversationId:a.scope.conversationId,workspaceId:a.scope.workspaceId,workspaceEpoch:a.scope.workspaceEpoch,workspaceFingerprint:a.scope.workspaceFingerprint??null},plans:plans.slice(-64).reverse().map(projectObjectHistory)};
  },{allowActiveWriter:true});
 };
}
export function createSessionRevertObjectQualification({store,withAuthority}={}){
 if(!store||typeof withAuthority!=='function')fail('invalid_projection');
 return async(req,body)=>{
  if(!closed(body,['owner','conversationId','evidenceIds','evidenceRevision'])||body.conversationId!==undefined&&!objectIdentifier(body.conversationId)
   ||!Array.isArray(body.evidenceIds)||!body.evidenceIds.length||body.evidenceIds.length>128||body.evidenceIds.some(x=>!objectIdentifier(x))||new Set(body.evidenceIds).size!==body.evidenceIds.length
   ||!Number.isSafeInteger(body.evidenceRevision)||body.evidenceRevision<0)fail('invalid_request');
  return withAuthority(req,body,async authority=>{
   const data=typeof store==='function'?await store():store;
   const summary=await data.queryEvidence(authority.scope,{limit:50});
   if(summary.revision!==body.evidenceRevision)fail('stale_evidence');
   const selected=summary.files.filter(file=>body.evidenceIds.some(id=>file.evidenceIds?.includes(id)));
   if(selected.length!==1||body.evidenceIds.some(id=>!selected[0].evidenceIds?.includes(id)))fail('evidence_not_found');
   await authority.revalidate();const current=await data.previewRevision(authority.scope);
   if(current.revision!==summary.revision||current.gapRevision!==summary.gapRevision)fail('stale_evidence');
   // The production prerequisite is definitively false. Do not label unknown
   // platform/metadata observations as supported, or synthesize a native ID.
   return {ok:true,providerId:OBJECT_PROVIDER_ID,riskNoticeVersion:OBJECT_RISK_VERSION,eligible:false,applyEligible:false,supported:false,
    reason:'production_allowlist_empty',fileId:objectFileId(authority.scope,selected[0].relativePath),objectId:null};
  },{allowActiveWriter:true});
 };
}
