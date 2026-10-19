// Test-only capability issuer. Never a production import or bundled executable.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{pathToFileURL}=require('node:url');
const {appendRetentionIndex}=require('./session-revert-retention.cjs');
const base=path.resolve(__dirname,'../..'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const owner={backendInstance:'D2',projectId:'fixture',repoId:null,workspaceId:'workspace',workspaceEpoch:'epoch',conversationId:'conversation',runtimeId:'runtime',runtimeGeneration:'generation',sessionId:'11111111-1111-4111-8111-111111111111'};
const scope={runtimeOwner:owner,workspaceId:owner.workspaceId,workspaceEpoch:owner.workspaceEpoch,conversationId:owner.conversationId,nativeSessionId:owner.sessionId};
let core;const activeRoots=new Set(),retainedRoots=new Set();
async function load(){
 if(core)return core;
 const source=await fs.readFile(path.join(base,'server/session-revert-object-writer.js'),'utf8');
 // Only this file adds the private export in memory. Fixed module imports are
 // resolved against the reviewed checkout, never a user fixture or helper cache.
 const resolved=source.replace(/from '(\.\.?\/[^']+)'/g,(_,p)=>"from '"+pathToFileURL(path.resolve(base,'server',p)).href+"'");
 core=await import('data:text/javascript;base64,'+Buffer.from(resolved+'\nexport { createIsolatedWriter };').toString('base64'));return core;
}
async function fixture(C,fn){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'p33-inplace-D2-'));const attempts=[];activeRoots.add(root);
 try{await fs.mkdir(path.join(root,'workspace'));await fs.writeFile(path.join(root,'workspace/file.txt'),C);return await fn(root,attempts);}
 finally{await Promise.allSettled(attempts.map(a=>a.close()));activeRoots.delete(root);assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^p33-inplace-D2-/);if(!retainedRoots.has(root))await fs.rm(root,{recursive:true,force:true});}
}
async function prepare(root,C,R,{relativePath='workspace/file.txt',helperBytes,extras=false,timeoutMs,spawnProcess}={}){
 assert.ok(activeRoots.has(root),'only this harness owns a fresh TEMP root');
 const {createSessionChangeStore}=await import('../../server/session-change-store.js');
 const {observeFileObject}=await import('../../server/session-revert-object-observer.js');
 const options={dataDir:path.join(root,'private-data')};let store=await createSessionChangeStore(options);
 const currentRef=await store.restorePut(scope,C),candidateRef=await store.restorePut(scope,R);
 const observation=await observeFileObject({root,relativePath,scope,operationId:'d2-fixture'});
 const authority=Object.freeze({root,scope:Object.freeze({...scope,runtimeOwner:Object.freeze({...owner})}),planId:crypto.randomUUID(),intentRevision:1});const capabilities=new WeakSet([authority]);
 const materials=async(a,c,r)=>{assert.equal(capabilities.has(a),true);return [await store.restoreDescriptor(scope,c),await store.restoreDescriptor(scope,r)];};
 const admit=o=>{
  assert.equal(o.status,'observed');assert.equal(o.profileId,'windows-original-object-v1');assert.equal(o.platform.fileSystem,'NTFS');assert.equal(o.platform.driveType,3);assert.equal(o.file.links,1);assert.equal(o.file.encoding,'utf8');assert.ok([32,34,8224,8226].includes(o.file.attributes));
  for(const k of ['owner','group','dacl'])assert.equal(o.security[k].state,'known');assert.equal(o.streams.state,'known');assert.equal(o.ea.state,'known');
  if(!extras){assert.deepEqual(o.streams.names,['::$DATA']);assert.equal(o.ea.bytes,0);}
 };
 const open=(await load()).createIsolatedWriter({owns:a=>capabilities.has(a)&&activeRoots.has(root),materials,admit,helperBytes,timeoutMs,spawnProcess});
 const args={authority,relativePath,currentRef,candidateRef,expectedObject:observation,proofId:'p33-d2-isolated'};
 const binding=a=>({planId:authority.planId,attemptId:a.attemptId,intentRevision:1,bindingDigest:a.bindingDigest});
 return {open,args,authority,currentRef,candidateRef,observation,scope,options,binding,async reopen(){store=await createSessionChangeStore(options);return store;},read:ref=>store.restoreRead(scope,ref),revoke:()=>capabilities.delete(authority),
  async retainFailure(observed,label){
   assert.ok(activeRoots.has(root));retainedRoots.add(root);const observedRef=await store.restorePut(scope,observed);
   // Private local inspection inventory, not a product plan or recovery journal.
   // No paths/contents are sent on native stdout or user-facing test output.
   await appendRetentionIndex(base,'p33-d2-retained-materials.jsonl',{testOnly:true,label,root,options,scope,currentRef,candidateRef,observedRef});
   return observedRef;
  }
 };
}
module.exports={fixture,prepare,load,hash,scope,base};
