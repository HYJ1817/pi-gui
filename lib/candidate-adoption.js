/* C1: observations and read-only conflict checks. No source writer or consent token. */
import fs from 'node:fs';
import path from 'node:path';
import {captureCandidateInput,assertCandidateTarget,candidateHash,candidatePath,candidateFail,CANDIDATE_LIMITS} from './candidate-snapshot.js';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=v=>candidateHash(JSON.stringify(v));
const fact=s=>[s.dev,s.ino,s.birthtimeMs];
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const identity=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
const exactIdentity=v=>Array.isArray(v)&&v.length===3&&v.every(n=>typeof n==='string'&&/^\d+$/.test(n));
const exactFact=s=>[s.dev.toString(),s.ino.toString(),s.birthtimeNs.toString()];
const objectAt=p=>exactFact(fs.lstatSync(p,{bigint:true}));
const resultView=r=>({files:r.files,truncated:r.truncated,inputId:r.inputId,outputId:r.outputId});
const qualification=r=>({reliable:r.reliable,unconfirmedReasons:r.unconfirmedReasons});
const workspaceBinding=r=>Object.fromEntries(['id','epoch','repoId','branch','path'].map(k=>[k,r.workspace?.[k]]));
function gitPointer(root){
  const file=path.join(root,'.git'),s=fs.lstatSync(file);
  if(s.isSymbolicLink()||!s.isDirectory()&&(!s.isFile()||s.nlink!==1||s.size>4096))candidateFail('candidate_unsafe');
  const objectIdentity=objectAt(file);
  if(s.isDirectory())return{kind:'directory',identity:fact(s),objectIdentity,digest:null};
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{
    const before=fs.fstatSync(fd);if(!equal(fact(s),fact(before))||!equal(exactFact(fs.fstatSync(fd,{bigint:true})),objectIdentity))candidateFail('candidate_changed');
    const bytes=Buffer.alloc(s.size+1),n=fs.readSync(fd,bytes,0,bytes.length,0),after=fs.fstatSync(fd),linked=fs.lstatSync(file);
    if(n!==s.size||after.size!==s.size||after.ctimeMs!==s.ctimeMs||after.mtimeMs!==s.mtimeMs||!equal(fact(s),fact(after))||!equal(fact(s),fact(linked)))candidateFail('candidate_changed');
    if(!equal(objectAt(file),objectIdentity)||!equal(exactFact(fs.fstatSync(fd,{bigint:true})),objectIdentity))candidateFail('candidate_changed');
    return{kind:'file',identity:fact(s),objectIdentity,digest:candidateHash(bytes.subarray(0,n))};
  }finally{fs.closeSync(fd);}
}
export function observeAdoptionSnapshot(s){
  const names=new Set();for(const f of [...s.files,...s.staged]){candidatePath(f.path);let p=path.dirname(path.join(s.root,f.path));while(p!==s.root){names.add(p);if(names.size>CANDIDATE_LIMITS.entries)candidateFail('candidate_limit');if(path.dirname(p)===p)candidateFail('candidate_unsafe');p=path.dirname(p);}}
  // Empty directories can occupy a future creation target or carry a changed
  // parent object despite identical file bytes. Ignored inputs are rejected by C1.
  if(!s.counts.ignored){let entries=0;const pending=[s.root];while(pending.length){const dir=pending.pop();
    for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(dir===s.root&&e.name==='.git')continue;
      if(++entries>CANDIDATE_LIMITS.entries)candidateFail('candidate_limit');
      if(e.isSymbolicLink()||!e.isDirectory()&&!e.isFile()||e.name.toLowerCase()==='.git')candidateFail('candidate_unsafe');
      if(e.isDirectory()){const p=path.join(dir,e.name);names.add(p);pending.push(p);}
    }
  }}
  const directories=[...names].sort().map(p=>{try{const st=fs.lstatSync(p);if(!st.isDirectory()||st.isSymbolicLink())candidateFail('candidate_unsafe');return[p,objectAt(p)];}catch(e){if(e.code==='ENOENT')return[p,null];throw e;}});
  return{root:s.root,admin:s.admin,common:s.common,head:s.head,contentId:s.contentId,staged:s.staged,configDigest:s.configDigest,
    identity:s.identity,objects:[s.root,s.admin,s.common].map(objectAt),gitPointer:gitPointer(s.root),directories,counts:s.counts,untracked:s.untracked,
    files:s.files.map(f=>{const p=path.join(s.root,f.path),st=fs.lstatSync(p);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||!equal(f.identity,fact(st)))candidateFail('candidate_changed');return{path:f.path,digest:f.digest,bytes:f.bytes.length,mode:f.mode,permissions:st.mode,identity:f.identity,objectIdentity:objectAt(p)};})};
}
export function createAdoptionEvidence({run,source,input,output,result}){
  const value={version:1,runId:run.id,executionState:run.state,sourceScope:run.sourceScope,workspace:workspaceBinding(run),qualification:qualification(result),source,input,output,resultDigest:hash(resultView(result))};
  if(Buffer.byteLength(JSON.stringify(value))>1024*1024-100)candidateFail('candidate_adoption_unsupported');
  return{...value,digest:hash(value)};
}
function validateObservation(s){
  if(!s||!['root','admin','common'].every(k=>typeof s[k]==='string'&&path.isAbsolute(s[k]))||!digest(s.contentId)||!digest(s.configDigest)
    ||!/^[a-f0-9]{40,64}$/.test(s.head)||!Array.isArray(s.identity)||s.identity.length!==3||!s.identity.every(identity)
    ||!Array.isArray(s.objects)||s.objects.length!==3||!s.objects.every(exactIdentity)||!Array.isArray(s.files)||s.files.length>CANDIDATE_LIMITS.files||!Array.isArray(s.staged)||s.staged.length>CANDIDATE_LIMITS.files
    ||!Array.isArray(s.untracked)||s.untracked.length>CANDIDATE_LIMITS.files||!Array.isArray(s.directories)||s.directories.length>CANDIDATE_LIMITS.entries||!s.counts||!['staged','working','untracked','ignored'].every(k=>Number.isSafeInteger(s.counts[k])&&s.counts[k]>=0)
    ||!['file','directory'].includes(s.gitPointer?.kind)||!identity(s.gitPointer.identity)||!exactIdentity(s.gitPointer.objectIdentity)||s.gitPointer.kind==='file'&&!digest(s.gitPointer.digest))candidateFail('candidate_adoption_unsupported');
  let bytes=0;const paths=new Set();
  for(const f of s.files){candidatePath(f.path);const key=process.platform==='win32'?f.path.toLowerCase():f.path;if(paths.has(key)||!digest(f.digest)||!identity(f.identity)||!exactIdentity(f.objectIdentity)||!Number.isSafeInteger(f.permissions)||!['100644','100755'].includes(f.mode)||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>CANDIDATE_LIMITS.fileBytes)candidateFail('candidate_adoption_unsupported');paths.add(key);bytes+=f.bytes;}
  if(bytes>CANDIDATE_LIMITS.totalBytes)candidateFail('candidate_adoption_unsupported');
  const indexed=new Set();for(const f of s.staged){candidatePath(f.path);if(indexed.has(f.path)||!['100644','100755'].includes(f.mode)||!/^[a-f0-9]{40,64}$/.test(f.oid))candidateFail('candidate_adoption_unsupported');indexed.add(f.path);}
  for(const p of s.untracked)candidatePath(p);
  for(const d of s.directories){if(!Array.isArray(d)||d.length!==2||typeof d[0]!=='string'||!d[0].startsWith(s.root+path.sep)||d[1]!==null&&!exactIdentity(d[1]))candidateFail('candidate_adoption_unsupported');}
  if(hash([s.head,s.staged,s.files.map(f=>[f.path,f.digest,f.mode])])!==s.contentId)candidateFail('candidate_adoption_unsupported');
}
export function validateAdoptionEvidence(e,run,result){
  try{
    if(!e||e.version!==1||e.runId!==run.id||e.executionState!==run.state||e.sourceScope!==run.sourceScope||!digest(e.digest)||Buffer.byteLength(JSON.stringify(e))>1024*1024)candidateFail('candidate_adoption_unsupported');
    const {digest:stored,...value}=e;if(hash(value)!==stored||hash(resultView(result))!==e.resultDigest||!equal(e.qualification,qualification(result))||!equal(e.workspace,workspaceBinding(run)))candidateFail('candidate_adoption_unsupported');
    validateObservation(e.source);validateObservation(e.input);validateObservation(e.output);
    if(e.source.contentId!==run.inputId||e.input.contentId!==e.source.contentId||e.input.root!==e.output.root||result.inputId!==e.source.contentId||result.outputId!==e.output.contentId||e.source.common!==e.output.common
      ||e.source.head!==e.output.head||!equal(e.source.staged,e.output.staged)||e.output.root!==run.workspace?.path)candidateFail('candidate_adoption_unsupported');
  }catch{candidateFail('candidate_adoption_unsupported');}
}
function assertCandidateHistory(input,output){
  if(!['root','admin','common','head','configDigest'].every(k=>input[k]===output[k])||!equal(input.identity,output.identity)||!equal(input.objects,output.objects)||!equal(input.gitPointer,output.gitPointer))candidateFail('candidate_adoption_unconfirmed');
  const after=new Map(output.files.map(f=>[f.path,f]));
  for(const f of input.files){const a=after.get(f.path);if(a&&(!equal(a.objectIdentity,f.objectIdentity)||a.mode!==f.mode||a.permissions!==f.permissions))candidateFail('candidate_adoption_unconfirmed');}
  const beforeDirs=new Map(input.directories.map(([p,id])=>[path.relative(input.root,p).split(path.sep).join('/'),id]));
  const afterDirs=new Map(output.directories.map(([p,id])=>[path.relative(output.root,p).split(path.sep).join('/'),id]));
  for(const [p,id]of beforeDirs)if(id&&!equal(afterDirs.get(p),id))candidateFail('candidate_adoption_unconfirmed');
  for(const [p,id]of afterDirs)if(id&&!beforeDirs.get(p)&&!output.files.some(f=>f.path.startsWith(p+'/')))candidateFail('candidate_adoption_unconfirmed');
}
const sameObservation=(s,expected)=>equal(observeAdoptionSnapshot(s),expected);
export async function checkCandidateAdoption({saved,scope,worktrees,assertIdle,materialize=false}){
  const check=()=>{scope.assertCurrent();assertIdle();};check();
  const {run,result,adoptionEvidence:e}=saved;
  if(run.sourceScope!==scope.key)candidateFail('candidate_scope');
  if(run.state!=='completed'||result?.reliable!==true||!Array.isArray(result.unconfirmedReasons)||result.unconfirmedReasons.length||result.truncated!==false
    ||!Array.isArray(result.files)||result.files.some(f=>f.truncated))candidateFail('candidate_adoption_ineligible');
  validateAdoptionEvidence(e,run,result);
  assertCandidateHistory(e.input,e.output);
  if(scope.projectRoot!==e.source.root||scope.workspaceCwd&&scope.workspaceCwd!==e.source.root)candidateFail('candidate_scope');
  if(e.source.counts.ignored||e.input.counts.ignored||e.output.counts.ignored)candidateFail('candidate_adoption_ignored');
  const source=await captureCandidateInput(e.source.root);check();
  if(source.counts.ignored)candidateFail('candidate_adoption_ignored');
  if(!sameObservation(source,e.source))candidateFail('candidate_source_changed');
  // Registry retains the lifecycle lock while inspecting the actual candidate.
  const post=await worktrees.withWorkspace(run.workspace,async w=>{
    check();if(w.root!==e.output.root||w.branch!==run.workspace.branch||w.workspaceId!==run.workspace.id||w.workspaceEpoch!==run.workspace.epoch||w.repoId!==run.workspace.repoId)candidateFail('candidate_output_changed');
    const s=await captureCandidateInput(w.root,{includeNew:true});check();
    if(s.counts.ignored)candidateFail('candidate_adoption_ignored');
    if(!sameObservation(s,e.output))candidateFail('candidate_output_changed');return s;
  });check();
  // The frozen Diff digest is bound to these exact input/output IDs by the
  // backend at finish. Preflight never materializes file contents into TEMP.
  // Recheck both sides after inspection; this is an observation, never a
  // promise that other OS writers cannot modify files after the response.
  const lastSource=await captureCandidateInput(e.source.root);check();
  if(!sameObservation(lastSource,e.source))candidateFail('candidate_source_changed');
  await worktrees.withWorkspace(run.workspace,async w=>{
    const last=await captureCandidateInput(w.root,{includeNew:true});check();if(!sameObservation(last,e.output))candidateFail('candidate_output_changed');
  });check();
  const before=new Map(source.files.map(f=>[f.path,f])),after=new Map(post.files.map(f=>[f.path,f]));
  const files=[...new Set([...before.keys(),...after.keys()])].sort().filter(p=>before.get(p)?.digest!==after.get(p)?.digest||before.get(p)?.mode!==after.get(p)?.mode)
    .map(p=>({path:p,change:!before.has(p)?'added':!after.has(p)?'deleted':'modified',beforeBytes:before.get(p)?.bytes.length??0,afterBytes:after.get(p)?.bytes.length??0}));
  if(!files.length)candidateFail('candidate_adoption_empty');
  for(const f of files)assertCandidateTarget(e.source.root,f.path);
  return{...(materialize?{sourceSnapshot:source,outputSnapshot:post}:{}),ok:true,state:'checked_readonly',canApply:false,code:'candidate_apply_unavailable',plan:{runId:run.id,source:e.source.root,branch:run.workspace.branch,
    head:e.source.head,inputId:e.source.contentId,outputId:e.output.contentId,files,counts:source.counts,indexEffect:'unchanged'}};
}
