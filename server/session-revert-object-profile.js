import { createHash } from 'node:crypto';
import { OBJECT_HELPER_HASH } from './session-revert-object-source.js';
export const OBJECT_PROFILE_ID='windows-original-object-v1';
export const PRODUCTION_OBJECT_ALLOWLIST=Object.freeze([]);
export const OBJECT_PLATFORM_CANDIDATES=Object.freeze(['10.0.26100.0','10.0.26200.0']);
// An observation-source label, NOT a production preservation certificate.
export const READONLY_OBJECT_PROOF=Object.freeze({proofId:'p33-d1-readonly',helperHash:OBJECT_HELPER_HASH,profileId:OBJECT_PROFILE_ID});
const hash=value=>createHash('sha256').update(value).digest('hex');
const OWNER=['backendInstance','projectId','repoId','workspaceId','workspaceEpoch','conversationId','runtimeId','runtimeGeneration','sessionId'];
export function objectScopeBinding(scope){
 const owner=scope?.runtimeOwner;
 if(!owner||!OWNER.every(k=>k==='repoId'&&owner[k]===null||typeof owner[k]==='string'&&owner[k].length>0&&owner[k].length<=256)
  ||scope.workspaceId!==owner.workspaceId||scope.workspaceEpoch!==owner.workspaceEpoch||scope.conversationId!==owner.conversationId||scope.nativeSessionId!==owner.sessionId)return null;
 return hash(JSON.stringify([...OWNER.map(k=>owner[k]),scope.workspaceFingerprint??null]));
}
export function normalizeObjectObservation(value){
 let count=0;
 const visit=(v,depth)=>{if(++count>4096||depth>10)throw Error();if(v===null||['string','boolean'].includes(typeof v)||typeof v==='number'&&Number.isFinite(v))return;
  if(typeof v!=='object'||!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype)throw Error();
  for(const k of Object.keys(v)){const d=Object.getOwnPropertyDescriptor(v,k);if(['__proto__','prototype','constructor'].includes(k)||!d||!Object.hasOwn(d,'value'))throw Error();visit(d.value,depth+1);}};
 try{visit(value,0);const text=JSON.stringify(value);if(Buffer.byteLength(text)>16384||!value||typeof value!=='object'||Array.isArray(value))throw Error();return JSON.parse(text);}
 catch{throw Object.assign(Error('object_observation_invalid'),{code:'object_observation_invalid'});}
}
export function evaluateObjectProfile({evidence,current,platformProof,helperHash}={}){
 let observations={before:null,after:null,current:null};
 const result=reason=>({observations,qualification:{eligible:false,reason,profileId:OBJECT_PROFILE_ID,proofId:typeof platformProof?.proofId==='string'?platformProof.proofId:null,helperHash:typeof helperHash==='string'?helperHash:null}});
 if(evidence?.objectEvidenceVersion!==1)return result('object_evidence_unavailable');
 try{observations={before:normalizeObjectObservation(evidence.beforeObjectEvidence),after:normalizeObjectObservation(evidence.afterObjectEvidence),current:normalizeObjectObservation(current?.observation)};}catch{return result('object_observation_unavailable');}
 const all=Object.values(observations);
 if(all.some(o=>o.profileId!==OBJECT_PROFILE_ID))return result('object_profile_unknown');
 if(helperHash!==OBJECT_HELPER_HASH||all.some(o=>o.source?.helperHash!==helperHash||o.source?.helperVersion!==1||o.source?.kind!=='win32-observe'))return result('object_helper_unknown');
 if(!platformProof||typeof platformProof.proofId!=='string'||!platformProof.proofId)return result('object_proof_unavailable');
 if(platformProof.proofId!==READONLY_OBJECT_PROOF.proofId)return result('object_proof_unknown');
 if(platformProof.helperHash!==helperHash)return result('object_proof_mismatch');
 if(platformProof.osVersion!==undefined&&platformProof.osVersion!==observations.current.platform?.osVersion)return result('object_proof_mismatch');
 for(const k of ['architecture','fileSystem','driveType','volumeId'])if(platformProof[k]!==undefined&&platformProof[k]!==observations.current.platform?.[k])return result('object_proof_mismatch');
 for(const o of all){
  if(o.version!==1||o.status!=='observed')return result('object_observation_unavailable');
  const p=o.platform,f=o.file;
  if(p?.state!=='known'||!OBJECT_PLATFORM_CANDIDATES.includes(p.osVersion)||p.architecture!=='x64'||p.fileSystem!=='NTFS'||p.driveType!==3||!p.volumeId)return result('object_platform_unsupported');
  if(!f?.id||f.state!=='known')return result('object_identity_unavailable');
  if(f.isFile!==true||f.reparse!==false||f.links!==1||o.path?.state!=='known'||!Array.isArray(o.path.parents)||!o.path.parents.length||o.path.parents.some(p=>!p.id||!p.binding||p.reparse!==false))return result('object_path_unsupported');
  if(o.streams?.state!=='known'||!Array.isArray(o.streams.names)||!o.streams.names.length)return result('object_streams_unavailable');
  if(o.streams.names.length!==1||o.streams.names[0]!=='::$DATA')return result('object_streams_unsupported');
  if(o.ea?.state!=='known'||!Number.isSafeInteger(o.ea.bytes))return result('object_ea_unavailable');
  if(o.ea.bytes!==0)return result('object_ea_unsupported');
  if(['owner','group','dacl'].some(k=>o.security?.[k]?.state!=='known'||typeof o.security[k].value!=='string'||!o.security[k].value))return result('object_security_unavailable');
  if(![32,34,8224,8226].includes(f.attributes))return result('object_attributes_unsupported');
  if(!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>2097152)return result('object_budget_exceeded');
  if(f.encoding!=='utf8'||typeof f.digest!=='string'||!/^[0-9a-f]{64}$/.test(f.digest))return result('object_text_unsupported');
  if(!o.security.sacl||!['known','unavailable','unknown'].includes(o.security.sacl.state)||o.security.sacl.state!=='known'&&o.security.sacl.value!==null||o.security.sacl.state==='known'&&typeof o.security.sacl.value!=='string')return result('object_security_unavailable');
 }
 if(!evidence.beforeRef||evidence.operationType&&!['modified','write','edit'].includes(evidence.operationType))return result('object_operation_unsupported');
 if(current.gapRevision!==0||evidence.attributionGapRevision!==0)return result('attribution_gap');
 if(evidence.evidenceLevel!=='intent_verified'||evidence.state!=='observed'||evidence.toolResultObserved!==true)return result('incomplete_evidence');
 if(!Number.isSafeInteger(evidence.createdAt)||Date.now()-evidence.createdAt>7*86400000||evidence.createdAt>Date.now()+1000)return result('expired_evidence');
 if(evidence.consumed===true)return result('already_reverted');
 const scope=objectScopeBinding(evidence.scope),actual=objectScopeBinding(current.scope);
 if(!scope||scope!==actual)return result('scope_mismatch');
 const pathBinding=hash(String(evidence.path).replaceAll('\\','/'));
 if(all.some(o=>o.binding?.scope!==scope||o.binding.operationId!==evidence.operationId||o.binding.relativePathHash!==pathBinding||o.path.relativePathHash!==pathBinding))return result('object_binding_mismatch');
 if(all.some(o=>o.file.id!==observations.before.file.id||o.platform.volumeId!==observations.before.platform.volumeId||JSON.stringify(o.path)!==JSON.stringify(observations.before.path)))return result('object_identity_changed');
 if(all.some(o=>o.file.attributes!==observations.before.file.attributes||['owner','group','dacl'].some(k=>o.security[k].value!==observations.before.security[k].value)))return result('object_metadata_changed');
 const readable=all.filter(o=>o.security.sacl.state==='known');if(readable.length>1&&readable.some(o=>o.security.sacl.value!==readable[0].security.sacl.value))return result('object_metadata_changed');
 if(observations.before.file.digest!==evidence.beforeRef.digest||observations.before.file.bytes!==evidence.beforeRef.bytes||observations.after.file.bytes!==evidence.observedAfterRef?.bytes||evidence.observedAfterRef?.bytes!==evidence.intendedAfterRef?.bytes||observations.after.file.digest!==evidence.observedAfterRef?.digest||evidence.observedAfterRef?.digest!==evidence.intendedAfterRef?.digest)return result('incomplete_evidence');
 // D1 has NO production proofs. Research, consent or caller-supplied flags never enable B.
 return result('production_allowlist_empty');
}
