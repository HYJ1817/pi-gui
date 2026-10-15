// D3 TEMP-only capability issuer. No formal module imports this test harness.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{pathToFileURL}=require('node:url');
const base=path.resolve(__dirname,'../..'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const activeRoots=new Set(),retainedRoots=new Set();let writerCore,serviceCore;
const {appendRetentionIndex}=require('./session-revert-retention.cjs');
async function internal(file,name){
 const source=await fs.readFile(path.join(base,'server',file),'utf8');
 const resolved=source.replace(/from '(\.\.?\/[^']+)'/g,(_,p)=>"from '"+pathToFileURL(path.resolve(base,'server',p)).href+"'");
 return import('data:text/javascript;base64,'+Buffer.from(resolved+'\nexport { '+name+' };').toString('base64'));
}
async function loadWriter(){return writerCore??=await internal('session-revert-object-writer.js','createIsolatedWriter');}
async function loadService(){return serviceCore??=await internal('session-revert-object-service.js','createObjectServiceCore, readObservedOriginal');}

// Failure-only, read-only diagnostics. Keep raw process errors, identities,
// ACLs, paths and evidence bytes out of CI logs; never change eligibility.
async function diagnosePrivacy(root){
 const {execFile}=require('node:child_process');
 const {resolveObjectInterpreter}=await import('../../server/session-revert-object-resources.js');
 const interpreter=await resolveObjectInterpreter();
 const env={...process.env,PI_GUI_ACL_DIAGNOSTIC_ROOT:path.join(root,'private-data','revert-evidence','v1')};
 for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
 const script="$ErrorActionPreference='Stop';try{$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();$sid=$identity.User;$allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544');foreach($part in @('root','objects')){$p=$env:PI_GUI_ACL_DIAGNOSTIC_ROOT;if($part -eq 'objects'){$p=Join-Path $p 'objects'};if(-not(Test-Path -LiteralPath $p)){[ordered]@{part=$part;exists=$false}|ConvertTo-Json -Compress;continue};$acl=Get-Acl -LiteralPath $p;$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]);$own=$false;$foreign=$false;foreach($r in $rules){if($r.AccessControlType -eq 'Allow'){if($allowed -notcontains $r.IdentityReference.Value){$foreign=$true};if($r.IdentityReference.Value -eq $sid.Value -and (($r.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)){$own=$true}}};[ordered]@{part=$part;exists=$true;ownerIsUser=($owner -eq $sid.Value);ownerIsTokenDefault=($owner -eq $identity.Owner.Value);ownerIsAllowed=($allowed -contains $owner);protected=$acl.AreAccessRulesProtected;ownFullControl=$own;foreignAllow=$foreign}|ConvertTo-Json -Compress}}catch{'{\"diagnosticFailed\":true}';exit 1}";
 const started=Date.now();
 await new Promise(resolve=>execFile(interpreter,['-NoProfile','-NonInteractive','-Command',script],{env,windowsHide:true,timeout:10000,maxBuffer:8192},(error,stdout)=>{
  const rows=[];for(const line of stdout.trim().split(/\r?\n/)){try{const row=JSON.parse(line);if(Object.keys(row).every(k=>k==='part'?['root','objects'].includes(row[k]):['exists','ownerIsUser','ownerIsTokenDefault','ownerIsAllowed','protected','ownFullControl','foreignAllow','diagnosticFailed'].includes(k)&&typeof row[k]==='boolean'))rows.push(row);}catch{}}
  console.error('TEMP store ACL diagnostic '+JSON.stringify({elapsedMs:Date.now()-started,processSucceeded:!error,timedOut:!!error?.killed,exitCode:Number.isInteger(error?.code)?error.code:null,rows}));resolve();
 }));
}

async function fixture(fn,{before=Buffer.from('base\nanchor\nuser\n'),after=Buffer.from('agent\nanchor\nuser\n'),current=Buffer.from('agent\nanchor\nuser-new\n'),relativePath='file.txt',storeOptions={},serviceOptions={},timeoutMs,spawnProcess,now=Date.now,ttlMs=60000}={}){
 if(process.platform!=='win32')throw Object.assign(Error('object_platform_unsupported'),{code:'object_platform_unsupported'});
 const tempRoot=await fs.realpath(os.tmpdir()),root=await fs.realpath(await fs.mkdtemp(path.join(tempRoot,'p33-D3-service-'))),attempts=[];activeRoots.add(root);
 let service;
 try{
  const {createSessionChangeStore}=await import('../../server/session-change-store.js');
  const {observeFileObject}=await import('../../server/session-revert-object-observer.js');
  const {evaluateObjectProfile,READONLY_OBJECT_PROOF,objectScopeBinding}=await import('../../server/session-revert-object-profile.js');
  const {OBJECT_HELPER_HASH}=await import('../../server/session-revert-object-source.js');
  const {objectFileId,OBJECT_WRITER_HASH,sameObjectScope}=await import('../../server/session-revert-object-contract.js');
  const {createSessionRevertAdmission}=await import('../../server/session-revert-admission.js');
  const {createSessionRevertMutationAuthority}=await import('../../server/session-revert-authority.js');
  const rootStat=await fs.stat(root),workspaceFingerprint=hash(JSON.stringify([rootStat.dev,rootStat.ino,rootStat.birthtimeMs]));
  const owner={backendInstance:'D3',projectId:'fixture',repoId:null,workspaceId:'workspace',workspaceEpoch:'epoch',conversationId:'conversation',runtimeId:'runtime',runtimeGeneration:'generation',sessionId:'11111111-1111-4111-8111-111111111111'};
  const scope={runtimeOwner:Object.freeze(owner),projectId:owner.projectId,repoId:owner.repoId,workspaceId:owner.workspaceId,workspaceEpoch:owner.workspaceEpoch,conversationId:owner.conversationId,nativeSessionId:owner.sessionId,workspaceFingerprint};
  const state={scope,stops:0,revalidations:0,nativeOpens:0,commitCalls:0,authorityActive:false,stopHook:null};
  const nativeCapabilities=new WeakSet(),storeCapabilities=new WeakSet(),capability=Object.freeze({});storeCapabilities.add(capability);
  const objectPlanAuthority=(s,id,cap)=>activeRoots.has(root)&&storeCapabilities.has(cap)&&sameObjectScope(scope,s)&&(id==null||typeof id==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(id));
  const options={...storeOptions,dataDir:path.join(root,'private-data'),objectPlanAuthority,now};
  let store;try{store=await createSessionChangeStore(options);}catch(error){if(error.code==='evidence_privacy_unavailable'&&!storeOptions.privacyCheck)await diagnosePrivacy(root).catch(()=>console.error('TEMP store ACL diagnostic unavailable'));throw error;}
  const target=path.join(root,...relativePath.split('/'));assert.equal(path.relative(root,target).startsWith('..'),false);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,before);
  const evidenceId='d3-evidence';
  await store.configure(scope,{enabled:true,acknowledged:true});
  const beforeObject=await observeFileObject({root,relativePath,scope,operationId:evidenceId,expectedDigest:hash(before)});
  assert.equal(beforeObject.status,'observed');
  await store.prepare(scope,{operationId:evidenceId,toolCallId:'d3-tool',path:relativePath,before,intendedAfter:after,effectiveToolSource:'gui-protected-default',objectEvidenceVersion:1,beforeObjectEvidence:beforeObject});
  await fs.writeFile(target,after);
  const afterObject=await observeFileObject({root,relativePath,scope,operationId:evidenceId,expectedDigest:hash(after)});
  await store.settle(scope,evidenceId,{observedAfter:after,toolOutcome:'success',mutationOutcome:'written',evidenceLevel:'intent_verified',objectEvidenceVersion:1,afterObjectEvidence:afterObject});
  await store.amendOutcome(scope,evidenceId,{toolOutcome:'success'});await fs.writeFile(target,current);
  const evidence=await store.read(scope,evidenceId);assert.equal(evidence.evidenceLevel,'intent_verified');assert.equal(evidence.toolResultObserved,true);
  const admission=createSessionRevertAdmission({timeoutMs:ttlMs});
  let authorityTail=Promise.resolve();
  const withAuthority=async(_req,body,action)=>{
   const prior=authorityTail;let release;authorityTail=new Promise(r=>release=r);await prior;
   try{
   assert.equal(activeRoots.has(root),true);assert.equal(state.authorityActive,false);
   if(body?.owner&&JSON.stringify(body.owner)!==JSON.stringify(state.scope.runtimeOwner))throw Object.assign(Error('stale_runtime'),{code:'stale_runtime'});
   const expected=JSON.stringify(state.scope);state.authorityActive=true;try{return await action({root,scope:state.scope,activeWriter:false,revalidate:async()=>{assert.equal(activeRoots.has(root),true);if(JSON.stringify(state.scope)!==expected)throw Object.assign(Error('stale_runtime'),{code:'stale_runtime'});state.revalidations++;}});}finally{state.authorityActive=false;}
   }finally{release();}
  };
  const withMutationAuthority=createSessionRevertMutationAuthority({withAuthority,admission,stopAndDrain:async()=>{assert.equal(state.authorityActive,false,'lifecycle authority released before Stop');state.stops++;await state.stopHook?.();}});
  const materials=async(authority,c,r)=>{assert.equal(nativeCapabilities.has(authority)&&activeRoots.has(root),true);assert.equal(sameObjectScope(authority.scope,scope),true);return [await store.restoreDescriptor(scope,c),await store.restoreDescriptor(scope,r)];};
  const admit=o=>{assert.equal(o.status,'observed');assert.equal(o.binding.scope,objectScopeBinding(scope));assert.equal(o.file.links,1);assert.equal(o.file.isFile,true);assert.equal(o.file.reparse,false);assert.equal(o.file.encoding,'utf8');assert.ok([32,34,8224,8226].includes(o.file.attributes));assert.deepEqual(o.streams.names,['::$DATA']);assert.equal(o.ea.bytes,0);for(const k of ['owner','group','dacl'])assert.equal(o.security[k].state,'known');};
  const helperBytes=await fs.readFile(path.join(base,'server/session-revert-object-write-native.ps1'));assert.equal(hash(helperBytes),OBJECT_WRITER_HASH,'approved helper verified before execution');
  const writer=(await loadWriter()).createIsolatedWriter({owns:a=>nativeCapabilities.has(a)&&activeRoots.has(root),materials,admit,helperBytes,timeoutMs,spawnProcess});
  const openAttempt=async args=>{
   assert.equal(activeRoots.has(root),true);assert.equal(args.authority.root,root);assert.equal(sameObjectScope(args.authority.scope,scope),true);
   const authority=Object.freeze({root,scope,planId:args.authority.planId,intentRevision:1});nativeCapabilities.add(authority);
   const attempt=await writer({...args,authority});attempts.push(attempt);state.nativeOpens++;
   return Object.freeze({...attempt,commit:async binding=>{state.commitCalls++;return attempt.commit(binding);},cancel:()=>attempt.cancel(),close:()=>attempt.close()});
  };
  const qualify=async({authority,evidence,current,scope:requestedScope})=>{
   assert.equal(activeRoots.has(root),true);assert.equal(authority.root,root);assert.equal(sameObjectScope(scope,requestedScope??authority.scope),true);
   const result=evaluateObjectProfile({evidence,current,platformProof:READONLY_OBJECT_PROOF,helperHash:OBJECT_HELPER_HASH});assert.equal(result.qualification.reason,'production_allowlist_empty');
   return {proofId:'p33-d2-isolated',helperHash:OBJECT_WRITER_HASH};
  };
  const dependencies={store:()=>store,withAuthority,withMutationAuthority,capability,qualify,openAttempt,now,ttlMs};
  const createService=async overrides=>{const core=(await loadService()).createObjectServiceCore;service=core({...dependencies,...serviceOptions,...overrides});return service;};
  service=await createService();
  const evidenceRevision=(await store.previewRevision(scope)).revision,fileId=objectFileId(scope,relativePath);
  const body={owner,conversationId:scope.conversationId,evidenceIds:[evidenceId],fileId,evidenceRevision};
  const confirmation=(p,requestId=crypto.randomUUID())=>({owner:state.scope.runtimeOwner,conversationId:scope.conversationId,providerId:'windows-original-object-v1',profileId:'windows-original-object-v1',helperHash:OBJECT_WRITER_HASH,proofId:'p33-d2-isolated',planId:p.planId,confirmationToken:p.confirmationToken,requestId,riskNoticeVersion:3,confirmation:{externalWritersPaused:true,lastCheckRaceAccepted:true,partialOverwriteAccepted:true,metadataLimitsAccepted:true}});
  const value={root,target,options,scope,state,admission,evidenceId,evidenceRevision,fileId,body,before,after,current,relativePath,confirmation,createService,dependencies,
   get store(){return store;},get service(){return service;},
   async reopen(){store=await createSessionChangeStore(options);return store;},
   async retain(){retainedRoots.add(root);await appendRetentionIndex(base,'p33-d3-retained-materials.jsonl',{testOnly:true,root,dataDir:options.dataDir,scope});return root;},
   async revoke(){storeCapabilities.delete(capability);},
  };
  return await fn(value);
 }finally{
  await Promise.allSettled(attempts.map(a=>a.close()));await service?.dispose?.();activeRoots.delete(root);
  assert.equal(path.dirname(root),tempRoot);assert.match(path.basename(root),/^p33-D3-service-/);
  if(!retainedRoots.has(root))await fs.rm(root,{recursive:true,force:true});
 }
}
module.exports={fixture,loadService,loadWriter,hash,base};
