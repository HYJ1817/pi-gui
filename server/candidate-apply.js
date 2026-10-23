/* Candidate authorization, file transaction and separately authorized recovery. */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {checkCandidateAdoption,observeAdoptionSnapshot} from '../lib/candidate-adoption.js';
import {captureCandidateInput,candidateFail,candidateHash} from '../lib/candidate-snapshot.js';
import {createCandidateTransactions} from './candidate-transactions.js';
import {openCandidateWriter} from './candidate-writer.js';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const terminal=new Set(['applied','failed_no_write','recovered']);
const idAt=p=>fs.lstatSync(p,{bigint:true}).ino.toString();
export function createCandidateApply({dataDir,worktrees,assertIdle,admission,protectedRoots,now=Date.now,hooks={}}){
 const store=createCandidateTransactions({dataDir,protectedRoots}),nonces=new Map();let active=false;
 const check=scope=>{scope.assertCurrent();assertIdle();};
 function summary(t){const steps=t.events.filter(e=>e.state==='step_verified');return{id:t.id,state:terminal.has(t.state)?t.state:'recovery_required',files:steps.length,runId:t.binding.runId,uncertain:['applying','recovering'].includes(t.state)||t.events.at(-1)?.uncertain===true};}
 function status(scope,runId){scope.assertCurrent();const tx=store.list().filter(t=>t.binding.scope===scope.key&&t.binding.runId===runId);return tx.length?summary(tx.at(-1)):{state:'not_applied'};}
 function available(scope,saved){check(scope);if(active&&!store.locked()||admission?.busy())candidateFail('candidate_busy');for(const t of store.list()){if(t.binding.source!==scope.projectRoot)continue;if(!terminal.has(t.state))candidateFail('candidate_recovery_required');if(t.binding.runId===saved.run.id&&t.state==='applied')candidateFail('candidate_already_applied');}}
 function issue(scope,value){if(nonces.size>=8)nonces.delete(nonces.keys().next().value);const nonce=randomUUID();nonces.set(nonce,{...value,scope,token:scope.token,expires:now()+120000});return nonce;}
 function consume(scope,nonce,kind){const p=nonces.get(nonce);nonces.delete(nonce);if(!p||p.kind!==kind||p.scope.key!==scope.key||p.token!==scope.token||p.expires<now())candidateFail('candidate_expired');try{p.scope.assertCurrent();}catch{candidateFail('candidate_expired');}check(scope);return p;}
 async function observe(scope,saved){const r=await checkCandidateAdoption({saved,scope,worktrees,assertIdle:()=>check(scope),materialize:true});for(const f of r.plan.files){const a=r.sourceSnapshot.files.find(v=>v.path===f.path),b=r.outputSnapshot.files.find(v=>v.path===f.path);if(a&&b&&a.mode!==b.mode||!fs.existsSync(path.dirname(path.join(scope.projectRoot,f.path))))candidateFail('candidate_write_unsupported');}return r;}
 async function prepare(scope,saved){available(scope,saved);if(process.platform!=='win32')candidateFail('candidate_platform_unsupported');const r=await observe(scope,saved);available(scope,saved);const nonce=issue(scope,{kind:'apply',saved,plan:r.plan});return{ok:true,state:'prepared',canApply:true,plan:r.plan,nonce,expiresAt:nonces.get(nonce).expires};}
 function pinsFor(source,changed){const pins=source.files.filter(f=>!changed.has(f.path)).map(f=>({path:path.join(source.root,f.path),identity:idAt(path.join(source.root,f.path))}));
  const paths=new Set([path.join(source.root,'.git'),path.join(source.admin,'HEAD'),path.join(source.admin,'index'),path.join(source.common,'config'),path.join(source.common,'packed-refs')]);
  function refs(dir){if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())candidateFail('candidate_unsafe');if(e.isDirectory())refs(p);else if(e.isFile()){paths.add(p);if(paths.size>512)candidateFail('candidate_limit');}else candidateFail('candidate_unsafe');}}
  refs(path.join(source.common,'refs'));for(const p of paths){if(!fs.existsSync(p))continue;const s=fs.lstatSync(p);if(s.isDirectory())continue;if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)candidateFail('candidate_unsafe');pins.push({path:p,identity:idAt(p)});}return pins;
 }
 function bind(scope,saved){return{scope:scope.key,source:scope.projectRoot,runId:saved.run.id,workspace:saved.run.workspace,evidence:saved.adoptionEvidence.digest,sourceObservation:saved.adoptionEvidence.source};}
 async function confirm(scope,nonce){const p=consume(scope,nonce,'apply');available(scope,p.saved);let writer=null,lease=null,execution=null,tx=null,attempted=false;try{
  execution=store.acquire();active=true;check(scope);available(scope,p.saved);
  const r=await observe(scope,p.saved);if(!equal(r.plan,p.plan))candidateFail('candidate_expired');
  lease=admission?.acquire(scope.projectRoot);await lease?.drain();lease?.pinForApply();
  const before=new Map(r.sourceSnapshot.files.map(f=>[f.path,f])),after=new Map(r.outputSnapshot.files.map(f=>[f.path,f]));
  const files=r.plan.files.map(f=>{const a=before.get(f.path),b=after.get(f.path);return{path:f.path,identity:a?idAt(path.join(scope.projectRoot,f.path)):null,before:a?.digest??null,after:b?.digest??null,bytes:b?.bytes.toString('base64')??null,original:a?.bytes.toString('base64')??null};});
  tx=store.create({binding:bind(scope,p.saved),plan:r.plan,files});
  writer=await openCandidateWriter({root:scope.projectRoot,recovery:tx.directory,files,pins:pinsFor(r.sourceSnapshot,new Set(files.map(f=>f.path)))});
  // Same final read as C1, now while OS handles exclude data writes/deletion.
  await observe(scope,p.saved);lease?.assertCurrent();
  for(let i=0;i<files.length;i++){check(scope);lease?.assertCurrent();await hooks.beforeStep?.(i,tx.id);store.append(tx.id,{state:'applying',step:i});attempted=true;const result=await writer.apply(i);store.append(tx.id,{state:'step_verified',step:i,result});await hooks.afterStep?.(i,tx.id);}
  const final=await captureCandidateInput(scope.projectRoot,{includeNew:true});check(scope);if(final.contentId!==r.outputSnapshot.contentId||!equal(final.staged,r.sourceSnapshot.staged))candidateFail('candidate_write_verification');
  store.append(tx.id,{state:'applied'});return{ok:true,...summary(store.read(tx.id))};
 }catch(e){if(!tx)throw e;let latest;try{latest=store.read(tx.id);const uncertain=latest.state==='applying';store.append(tx.id,{state:attempted?'recovery_required':'failed_no_write',uncertain,code:attempted?'candidate_recovery_required':'candidate_write_refused'});return{ok:true,...summary(store.read(tx.id))};}catch{candidateFail('candidate_recovery_required');}}
 finally{await writer?.close().catch(()=>{});lease?.release();execution?.release();active=false;}}
 function ownTx(scope,id){check(scope);const tx=store.read(id);if(tx.binding.scope!==scope.key||tx.binding.source!==scope.projectRoot)candidateFail('candidate_scope');return tx;}
 function recoveryFiles(tx){if(!['recovery_required','step_verified'].includes(tx.state)||tx.events.at(-1)?.uncertain)candidateFail('candidate_recovery_uncertain');const observation=tx.binding.sourceObservation;
  if(!observation||[observation.root,observation.admin,observation.common].some((p,i)=>{const s=fs.lstatSync(p,{bigint:true});return s.isSymbolicLink()||!s.isDirectory()||!equal([s.dev,s.ino,s.birthtimeNs].map(String),observation.objects[i]);}))candidateFail('candidate_recovery_external');
  const steps=tx.events.filter(e=>e.state==='step_verified');if(!steps.length)candidateFail('candidate_recovery_uncertain');
  return steps.map(e=>{const f=tx.files[e.step];if(!f||e.result.index!==e.step)candidateFail('candidate_storage_unsafe');const restore=f.after===null?path.join(tx.directory,'deleted-'+e.step):null,target=restore||path.join(tx.binding.source,f.path),st=fs.lstatSync(target);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||idAt(target)!==e.result.identity||candidateHash(fs.readFileSync(target))!==(f.after??f.before)||restore&&fs.existsSync(path.join(tx.binding.source,f.path)))candidateFail('candidate_recovery_external');return{path:f.path,identity:e.result.identity,before:f.after??f.before,after:f.before,bytes:f.original,restore};});
 }
 async function verifyRecoveryScope(scope,tx){const current=await captureCandidateInput(scope.projectRoot,{includeNew:true}),ob=observeAdoptionSnapshot(current),before=tx.binding.sourceObservation;
  for(const k of ['root','admin','common','head','staged','configDigest','identity','objects','gitPointer','directories'])if(!equal(ob[k],before[k]))candidateFail('candidate_recovery_external');
  if(ob.counts.ignored)candidateFail('candidate_recovery_external');
  const expected=new Map(before.files.map(f=>[f.path,{digest:f.digest,identity:f.objectIdentity[1],mode:f.mode}]));
  for(const e of tx.events.filter(e=>e.state==='step_verified')){const f=tx.files[e.step];if(f.after===null)expected.delete(f.path);else expected.set(f.path,{digest:f.after,identity:e.result.identity,mode:before.files.find(v=>v.path===f.path)?.mode||'100644'});}
  if(ob.files.length!==expected.size||ob.files.some(f=>{const e=expected.get(f.path);return!e||f.digest!==e.digest||f.objectIdentity[1]!==e.identity||f.mode!==e.mode;}))candidateFail('candidate_recovery_external');check(scope);return current;
 }
 async function prepareRecovery(scope,id){if(active||admission?.busy())candidateFail('candidate_busy');let execution=null;try{execution=store.acquire();active=true;const tx=ownTx(scope,id),files=recoveryFiles(tx);await verifyRecoveryScope(scope,tx);check(scope);return{ok:true,state:'recovery_prepared',id,files:files.map(f=>({path:f.path})),nonce:issue(scope,{kind:'recover',id,revision:tx.revision})};}finally{execution?.release();active=false;}}
 async function confirmRecovery(scope,nonce){const p=consume(scope,nonce,'recover');if(active)candidateFail('candidate_busy');let writer=null,lease=null,execution=null,tx=null;try{execution=store.acquire();active=true;tx=ownTx(scope,p.id);if(tx.revision!==p.revision)candidateFail('candidate_expired');const files=recoveryFiles(tx);
  lease=admission?.acquire(scope.projectRoot);await lease?.drain();lease?.pinForApply();const recovery=path.join(tx.directory,'rollback');fs.mkdirSync(recovery,{mode:0o700});
   const current=await verifyRecoveryScope(scope,tx);writer=await openCandidateWriter({root:scope.projectRoot,recovery,gate:path.join(path.dirname(tx.directory),'active.lock'),files,pins:pinsFor(current,new Set(files.map(f=>f.path)))});recoveryFiles(tx);await verifyRecoveryScope(scope,tx);store.append(tx.id,{state:'recovering'});
   for(let i=0;i<files.length;i++){scope.assertCurrent();lease?.assertCurrent();store.append(tx.id,{state:'recovering',step:i});await writer.apply(i);store.append(tx.id,{state:'recovery_step_verified',step:i});await hooks.afterRecoveryStep?.(i,tx.id);}
   const restored=await captureCandidateInput(scope.projectRoot,{includeNew:true});if(restored.contentId!==tx.plan.inputId)candidateFail('candidate_recovery_uncertain');store.append(tx.id,{state:'recovered'});return{ok:true,...summary(store.read(tx.id))};
  }catch{try{store.append(tx.id,{state:'recovery_required',uncertain:true});}catch{}return{ok:true,id:tx.id,state:'recovery_required',uncertain:true};}
  finally{await writer?.close().catch(()=>{});lease?.release();execution?.release();active=false;}}
 return{prepare,confirm,prepareRecovery,confirmRecovery,status,busy:()=>active,cancel(scope,nonce){const p=nonces.get(nonce);if(p?.scope.key!==scope.key)candidateFail('candidate_scope');nonces.delete(nonce);return{ok:true};}};
}
