import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { loadObjectHelper, resolveObjectInterpreter } from './session-revert-object-resources.js';
import { OBJECT_HELPER_HASH } from './session-revert-object-source.js';
import { OBJECT_PROFILE_ID, OBJECT_PLATFORM_CANDIDATES, normalizeObjectObservation, objectScopeBinding } from './session-revert-object-profile.js';
const digest=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const exact=(o,keys)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).sort().join('|')===keys.slice().sort().join('|');
// D2 intentionally exposes no executable provider, factory or test switch.
export async function openOriginalAttempt(){fail('production_allowlist_empty');}

// NOT exported or imported by the composition root. The repository TEMP harness
// evaluates this module with an extra test-only export; packaged code has none.
function createIsolatedWriter({owns,materials,admit,helperBytes,spawnProcess=spawn,timeoutMs=30000}){
 return async function open({authority,relativePath,currentRef,candidateRef,expectedObject,proofId}={}){
  if(process.platform!=='win32')fail('object_platform_unsupported');
  if(!owns(authority))fail('isolated_authority_required');
  if(!exact(currentRef,['digest','bytes'])||!exact(candidateRef,['digest','bytes']))fail('invalid_material');
  currentRef=Object.freeze({...currentRef});candidateRef=Object.freeze({...candidateRef});
  const root=authority.root;
  if(!path.isAbsolute(root)||root.startsWith('\\\\')||typeof relativePath!=='string'||!relativePath||relativePath.length>4096||path.win32.isAbsolute(relativePath)||/[\x00-\x1f\x7f:]/.test(relativePath)||relativePath.replaceAll('\\','/').split('/').some(p=>!p||p==='.'||p==='..'||['.git','.pi'].includes(p.toLowerCase())))fail('unsupported_path');
  if(proofId!=='p33-d2-isolated'||expectedObject?.version!==1)fail('object_proof_mismatch');
  expectedObject=normalizeObjectObservation(expectedObject);
  if(!exact(expectedObject,['version','profileId','source','binding','status','platform','file','path','security','streams','ea','times','nonAtomic']))fail('object_observation_invalid');
  if(expectedObject.profileId!==OBJECT_PROFILE_ID||expectedObject.source?.helperHash!==OBJECT_HELPER_HASH||expectedObject.source?.helperVersion!==1||expectedObject.source?.kind!=='win32-observe')fail('object_profile_mismatch');
  if(expectedObject.platform?.fileSystem!=='NTFS'||expectedObject.platform.driveType!==3||!OBJECT_PLATFORM_CANDIDATES.includes(expectedObject.platform.osVersion)||expectedObject.platform.architecture!=='x64')fail('object_platform_unsupported');
  if(expectedObject.binding?.scope!==objectScopeBinding(authority.scope)||expectedObject.binding?.relativePathHash!==digest(relativePath.replaceAll('\\','/'))||expectedObject.path?.relativePathHash!==expectedObject.binding.relativePathHash)fail('object_binding_mismatch');
  admit(expectedObject);
  const descriptors=await materials(authority,currentRef,candidateRef);
  const inputs=[];
  for(const d of descriptors){
   if(d?.version!==1||!path.isAbsolute(d.privatePath)||!/^[a-f0-9]{64}$/.test(d.digest)||!Number.isSafeInteger(d.bytes)||d.bytes<0||d.bytes>2097152)fail('invalid_material');
   const st=await fs.lstat(d.privatePath),big=await fs.lstat(d.privatePath,{bigint:true});
   if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.dev!==d.identity.dev||st.ino!==d.identity.ino||st.birthtimeMs!==d.identity.birthtimeMs||st.size!==d.bytes)fail('material_identity_changed');
   inputs.push({path:d.privatePath,digest:d.digest,bytes:d.bytes,ino:big.ino.toString()});
  }
  if(inputs.length!==2)fail('invalid_material');
  // helperBytes is the existing private in-memory fault harness adapter. It is
  // unreachable from production; ordinary resource reads must pass D4 integrity.
  const bytes=helperBytes||loadObjectHelper('writer').bytes;
  const helperHash=digest(bytes),attemptId=randomUUID(),nonce=randomBytes(32).toString('hex');
  const bindingDigest=digest(JSON.stringify({attemptId,nonce,planId:authority.planId,intentRevision:authority.intentRevision,scope:objectScopeBinding(authority.scope),root,relativePath,inputs,expectedObject,proofId,helperHash}));
  const request={version:1,command:'open',attemptId,nonce,bindingDigest,planId:authority.planId,intentRevision:authority.intentRevision,root,relativePath,inputs,expectedObject};
  const agrees=(m,expected)=>m&&m.creation===expected.times?.creation&&m.id===expected.file.id&&m.links===1&&m.attributes===expected.file.attributes&&['owner','group','dacl'].every(k=>m[k]===expected.security[k].value)&&m.eaBytes===expected.ea.bytes&&JSON.stringify(m.streams)===JSON.stringify(expected.streams.names)&&JSON.stringify(m.parents)===JSON.stringify(expected.path.parents.map(p=>p.id))&&(expected.security.sacl.state!=='known'||m.saclState==='known'&&m.sacl===expected.security.sacl.value);
  const encode=o=>JSON.stringify(o).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))+'\n';
  if(Buffer.byteLength(encode(request))>32768)fail('protocol_budget');
  const env={...process.env};for(const k of Object.keys(env))if(k.toLowerCase()==='psmodulepath')delete env[k];
  // Windows command lines cannot hold the full interop source. A fixed bootstrap
  // accepts only the backend's bounded, hash-bound static resource on stdin.
  if(bytes.length>24576)fail('helper_budget');
  const bootstrap=`$ErrorActionPreference='Stop';$b=[Text.StringBuilder]::new();while($true){$c=[Console]::In.Read();if($c -lt 0){exit 2};if($c -eq 10){break};if($b.Length -ge 32768){exit 2};[void]$b.Append([char]$c)};$s=[Convert]::FromBase64String($b.ToString());$h=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($s)).Replace('-','').ToLowerInvariant();if($h -cne '${helperHash}'){exit 2};& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($s)))`;
  const interpreter=await resolveObjectInterpreter();
  const child=spawnProcess(interpreter,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(bootstrap,'utf16le').toString('base64')],{env,cwd:path.dirname(interpreter),shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let state='opening',buffer='',outputBytes=0,committed=false,terminal=null,exited=false,protocolBad=false;
  let readyResolve,resultResolve;const ready=new Promise(r=>readyResolve=r),result=new Promise(r=>resultResolve=r);
  const uncertain=()=>({status:committed?'recovery_required':'not_applied',reason:'native_unconfirmed',retryAllowed:false,durable:false});
  const abort=()=>{protocolBad=true;child.kill();};
  const timer=setTimeout(abort,timeoutMs);timer.unref?.();
  child.stdin.on('error',()=>{});child.stderr.resume();
  child.stdout.on('data',b=>{
   outputBytes+=b.length;if(outputBytes>65536)return abort();buffer+=b.toString('utf8');
   while(buffer.includes('\n')){const n=buffer.indexOf('\n'),line=buffer.slice(0,n);buffer=buffer.slice(n+1);let row;try{row=JSON.parse(line);}catch{return abort();}
    if(!exact(row,['version','phase','attemptId','bindingDigest','status','measurement'])||row.version!==1||row.attemptId!==attemptId||row.bindingDigest!==bindingDigest)return abort();
    if(row.phase==='ready'&&state==='opening'&&row.status==='ready'){
     if(!agrees(row.measurement,expectedObject)||row.measurement.digest!==inputs[0].digest)return abort();state='ready';readyResolve(row);
    }
    else if(row.phase==='result'&&!terminal&&['opening','ready','committing','cancelled'].includes(state)&&['not_applied','refused','verified','recovery_required'].includes(row.status)){
     if(row.status==='verified'&&(!committed||row.measurement?.digest!==inputs[1].digest||row.measurement?.bytes!==inputs[1].bytes||!agrees(row.measurement,expectedObject)||row.measurement?.metadataEqual!==true))return abort();
     terminal={status:row.status,measurement:row.measurement,retryAllowed:false,durable:false};state='finished';
    }else return abort();
   }
  });
  const finish=code=>{if(exited)return;exited=true;clearTimeout(timer);state='closed';readyResolve(null);resultResolve(!protocolBad&&!buffer.trim()&&code===0&&terminal?terminal:uncertain());};
  child.on('error',()=>{protocolBad=true;finish(null);});child.on('close',finish);child.stdin.write(bytes.toString('base64')+'\n'+encode(request));
  const row=await ready;if(!row){await result;fail('native_not_ready');}
  return Object.freeze({attemptId,bindingDigest,helperHash,ready:row.measurement,
   async commit(binding){
    if(state!=='ready'||!owns(authority)||!exact(binding,['planId','attemptId','intentRevision','bindingDigest'])||binding.planId!==authority.planId||binding.attemptId!==attemptId||binding.intentRevision!==authority.intentRevision||binding.bindingDigest!==bindingDigest)fail('invalid_commit');
    // Revalidate registered references, permissions and descriptor identity at use.
    await materials(authority,currentRef,candidateRef);
    if(state!=='ready'||!owns(authority))fail('invalid_commit');
    state='committing';committed=true;child.stdin.end(encode({version:1,command:'commit',attemptId,nonce,bindingDigest,planId:authority.planId,intentRevision:authority.intentRevision}));return result;
   },
   async cancel(){if(state==='ready'){state='cancelled';child.stdin.end(encode({version:1,command:'cancel',attemptId,nonce,bindingDigest,planId:authority.planId,intentRevision:authority.intentRevision}));}return result;},
   async close(){if(state==='ready')return this.cancel();return result;}
  });
 };
}
