import { createHash } from 'node:crypto';
import { objectScopeBinding, OBJECT_PROFILE_ID, normalizeObjectObservation, OBJECT_PLATFORM_CANDIDATES } from './session-revert-object-profile.js';
import { OBJECT_HELPER_HASH } from './session-revert-object-source.js';
export const OBJECT_PROVIDER_ID='windows-original-object-v1';
export const OBJECT_WRITER_HASH='7d773b63777d97a6a78d9a81c37cf946929062b22028425889258becd3aa39ef';
export const OBJECT_RISK_VERSION=2;
export const objectHash=value=>createHash('sha256').update(value).digest('hex');
export const objectFail=code=>{throw Object.assign(Error(code),{code});};
export const objectIdentifier=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(x);
const hex=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
export function sameObjectScope(a,b){const key=objectScopeBinding(a);return Boolean(key)&&key===objectScopeBinding(b);}
export function objectRelativePath(p){
 if(typeof p!=='string'||!p||p.length>4096||/^[\\/]|^[A-Za-z]:|[\x00-\x1f\x7f:]/.test(p))objectFail('unsupported_path');
 const n=p.replaceAll('\\','/');if(n.split('/').some(k=>!k||k==='.'||k==='..'||/[. ]$/.test(k)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(k)||['.git','.pi'].includes(k.toLowerCase())||/^\.env(?:\.|$)/i.test(k)||/\.(?:pem|key|p12|pfx)$/i.test(k)))objectFail('unsupported_path');return n;
}
export function objectFileId(scope,p){return objectHash(JSON.stringify([objectScopeBinding(scope),objectRelativePath(p)]));}
export function objectBoundedJson(value,maxBytes=256*1024){
 let nodes=0;const visit=(v,d)=>{if(++nodes>20000||d>16)objectFail('object_schema_invalid');if(v===null||['boolean','string'].includes(typeof v)||typeof v==='number'&&Number.isFinite(v))return;
  if(typeof v!=='object'||!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype)objectFail('object_schema_invalid');
  for(const k of Object.keys(v)){const p=Object.getOwnPropertyDescriptor(v,k);if(['__proto__','constructor','prototype'].includes(k)||!p||!Object.hasOwn(p,'value'))objectFail('object_schema_invalid');visit(p.value,d+1);}};
 visit(value,0);const text=JSON.stringify(value);if(Buffer.byteLength(text)>maxBytes)objectFail('object_budget_exceeded');return JSON.parse(text);
}
export function validateObjectRef(ref){if(!ref||Object.keys(ref).sort().join('|')!=='bytes|digest'||!hex(ref.digest)||!Number.isSafeInteger(ref.bytes)||ref.bytes<0||ref.bytes>2097152)objectFail('object_schema_invalid');}
export function validateObjectPlan(input){
 const p=objectBoundedJson(input),states=['prepared','replacing','applied_verified','recovery_required','not_applied'];
 if(p.runtimeContext!==undefined&&(!Number.isSafeInteger(p.runtimeContext)||p.runtimeContext<0))objectFail('object_schema_invalid');
 if(p.scope?.projectId!==undefined&&p.scope.projectId!==p.scope.runtimeOwner?.projectId||p.scope?.repoId!==undefined&&p.scope.repoId!==p.scope.runtimeOwner?.repoId)objectFail('object_schema_invalid');
 if(p.schemaVersion!==1||p.providerId!==OBJECT_PROVIDER_ID||p.profileId!==OBJECT_PROFILE_ID||p.helperHash!==OBJECT_WRITER_HASH||!objectIdentifier(p.proofId)||p.riskNoticeVersion!==OBJECT_RISK_VERSION||!objectIdentifier(p.planId)||!hex(p.tokenHash)||!objectScopeBinding(p.scope)||p.scope.workspaceFingerprint!=null&&!hex(p.scope.workspaceFingerprint))objectFail('object_schema_invalid');
 if(!['revert','recover'].includes(p.kind)||!states.includes(p.state)||p.completion!==p.state||!Number.isSafeInteger(p.expiresAt)||!Number.isSafeInteger(p.createdAt)||!Number.isSafeInteger(p.updatedAt)||p.expiresAt<=p.createdAt||p.expiresAt-p.createdAt>60000||!Number.isSafeInteger(p.evidenceRevision)||!Number.isSafeInteger(p.revision)||p.revision<1||!Number.isSafeInteger(p.gapRevision)||p.gapRevision!==0)objectFail('object_schema_invalid');
 if(p.evidenceRevision<0||p.updatedAt<p.createdAt||!Array.isArray(p.selectedOperationIds)||p.selectedOperationIds.length>128||p.selectedOperationIds.some(x=>!objectIdentifier(x))||new Set(p.selectedOperationIds).size!==p.selectedOperationIds.length||!Array.isArray(p.consumedOperationIds)||new Set(p.consumedOperationIds).size!==p.consumedOperationIds.length||p.consumedOperationIds.some(x=>!p.selectedOperationIds.includes(x)))objectFail('object_schema_invalid');
 if(p.kind==='revert'&&(!p.selectedOperationIds.length||p.sourcePlanId!==null)||p.kind==='recover'&&(!objectIdentifier(p.sourcePlanId)||p.selectedOperationIds.length))objectFail('object_schema_invalid');
 if(p.requestId!==null&&!objectIdentifier(p.requestId)||!Array.isArray(p.files)||p.files.length!==1)objectFail('object_schema_invalid');
 const f=p.files[0];validateObjectRef(f.currentRef);validateObjectRef(f.candidateRef);
 if(f.action!=='write_original'||f.fileId!==objectFileId(p.scope,f.relativePath)||objectRelativePath(f.relativePath)!==f.relativePath||f.state!==p.state||JSON.stringify(f.operationIds)!==JSON.stringify(p.selectedOperationIds))objectFail('object_schema_invalid');
 const o=normalizeObjectObservation(f.currentObject);
 if(o.version!==1||o.profileId!==OBJECT_PROFILE_ID||o.status!=='observed'||o.source?.kind!=='win32-observe'||o.source.helperVersion!==1||o.source.helperHash!==OBJECT_HELPER_HASH||o.binding?.scope!==objectScopeBinding(p.scope)||o.binding.relativePathHash!==objectHash(f.relativePath)||o.path?.relativePathHash!==o.binding.relativePathHash)objectFail('object_schema_invalid');
 if(o.file?.id==null||o.file.links!==1||o.file.isFile!==true||o.file.reparse!==false||o.file.encoding!=='utf8'||o.file.digest!==f.currentRef.digest||o.file.bytes!==f.currentRef.bytes||![32,34,8224,8226].includes(o.file.attributes)||o.platform?.state!=='known'||!OBJECT_PLATFORM_CANDIDATES.includes(o.platform.osVersion)||o.platform.architecture!=='x64'||o.platform.fileSystem!=='NTFS'||o.platform.driveType!==3||o.ea?.state!=='known'||o.ea.bytes!==0||o.streams?.state!=='known'||JSON.stringify(o.streams.names)!=='["::$DATA"]'||['owner','group','dacl'].some(k=>o.security?.[k]?.state!=='known'||typeof o.security[k].value!=='string'||!o.security[k].value))objectFail('object_schema_invalid');
 if(o.file.state!=='known'||o.path?.state!=='known'||!Array.isArray(o.path.parents)||!o.path.parents.length||o.path.parents.some(x=>typeof x.id!=='string'||!x.id||typeof x.binding!=='string'||!x.binding||x.reparse!==false)||o.times?.state!=='known'||typeof o.times.creation!=='string'||!o.times.creation||!o.platform.volumeId||!o.security.sacl||!['known','unavailable','unknown'].includes(o.security.sacl.state)||o.security.sacl.state==='known'&&typeof o.security.sacl.value!=='string'||o.security.sacl.state!=='known'&&o.security.sacl.value!==null)objectFail('object_schema_invalid');
 if(p.journalReserveRemaining!==undefined&&(!Number.isSafeInteger(p.journalReserveRemaining)||p.journalReserveRemaining<0||p.journalReserveRemaining>262144))objectFail('object_schema_invalid');
 if(['replacing','applied_verified','recovery_required'].includes(p.state)&&!f.intent||f.intent){
  const i=f.intent;if(!i||!objectIdentifier(i.attemptId)||!hex(i.bindingDigest)||i.nativeIntentRevision!==1||i.journalRevision<1||i.journalRevision>p.revision||!Number.isSafeInteger(i.journalRevision)||i.helperHash!==p.helperHash||i.requestId!==p.requestId||i.readyDigest!==f.currentRef.digest||i.readyObjectId!==o.file.id)objectFail('object_schema_invalid');
 }
 if(p.state==='prepared'&&(p.requestId!==null||f.intent!==null)||p.state==='applied_verified'&&(f.observedPostDigest!==f.candidateRef.digest||f.verifiedMeasurement?.digest!==f.candidateRef.digest||f.verifiedMeasurement?.bytes!==f.candidateRef.bytes||f.verifiedMeasurement?.id!==o.file.id||f.verifiedMeasurement?.metadataEqual!==true))objectFail('object_schema_invalid');
 return p;
}
