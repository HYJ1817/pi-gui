const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
let passed=0,failed=0,skipped=0;
const check=async(name,fn)=>{try{await fn();passed++;console.log('ok '+name);}catch(e){failed++;console.error('FAIL '+name+': '+(e.code||e.name));}};
(async()=>{
 let m;try{m=await import('../server/session-revert-object-profile.js');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
 await check('independent object profile exists',()=>assert.equal(typeof m?.evaluateObjectProfile,'function'));
 if(!m){console.log(`Object profile: ${passed}/${passed+failed}; failed=${failed}; skipped=0`);process.exitCode=1;return;}
 const {OBJECT_HELPER_HASH}=await import('../server/session-revert-object-source.js');
 const scope={runtimeOwner:{backendInstance:'b',projectId:'p',repoId:null,workspaceId:'w',workspaceEpoch:'e',conversationId:'c',runtimeId:'r',runtimeGeneration:'g',sessionId:'s'},workspaceId:'w',workspaceEpoch:'e',conversationId:'c',nativeSessionId:'s'};
 const observe=()=>({version:1,profileId:m.OBJECT_PROFILE_ID,status:'observed',source:{kind:'win32-observe',helperVersion:1,helperHash:OBJECT_HELPER_HASH},
  binding:{scope:m.objectScopeBinding(scope),operationId:'operation',relativePathHash:hash('file.txt')},
  platform:{state:'known',osVersion:'10.0.26200.0',architecture:'x64',fileSystem:'NTFS',driveType:3,volumeId:'1234'},
  file:{state:'known',id:'1234:5678',links:1,bytes:4,attributes:8226,reparse:false,isFile:true,digest:hash('text'),encoding:'utf8'},
  path:{state:'known',relativePathHash:hash('file.txt'),parents:[{id:'1234:1111',binding:hash('parent'),reparse:false}]},
  security:{owner:{state:'known',value:'S-1-5-21-1'},group:{state:'known',value:'S-1-5-21-1'},dacl:{state:'known',value:'D:P(A;;FA;;;SY)'},sacl:{state:'unavailable',value:null}},
  streams:{state:'known',names:['::$DATA']},ea:{state:'known',bytes:0},times:{state:'known',creation:'1',lastAccess:'2',lastWrite:'3'},nonAtomic:true});
 const make=()=>{const o=observe();return {evidence:{objectEvidenceVersion:1,beforeObjectEvidence:structuredClone(o),afterObjectEvidence:structuredClone(o),scope,operationId:'operation',path:'file.txt',evidenceLevel:'intent_verified',toolResultObserved:true,state:'observed',beforeRef:{digest:hash('text'),bytes:4},intendedAfterRef:{digest:hash('text'),bytes:4},observedAfterRef:{digest:hash('text'),bytes:4},attributionGapRevision:0,createdAt:Date.now(),consumed:false},current:{observation:o,scope,gapRevision:0},platformProof:{proofId:'p33-d1-readonly',status:'research',helperHash:OBJECT_HELPER_HASH},helperHash:OBJECT_HELPER_HASH};};
 const refuse=async(name,mutate,reason)=>check(name,()=>{const x=make();mutate(x);const r=m.evaluateObjectProfile(x);assert.equal(r.qualification.eligible,false);assert.equal(r.qualification.reason,reason);});
 await check('well formed observation keeps private SACL unknown and no production eligibility',()=>{const r=m.evaluateObjectProfile(make());assert.equal(r.observations.current.security.sacl.state,'unavailable');assert.equal(r.observations.current.security.sacl.value,null);assert.equal(r.qualification.reason,'production_allowlist_empty');assert.deepEqual(m.PRODUCTION_OBJECT_ALLOWLIST,[]);});
 const cases=[
 ['legacy evidence',x=>delete x.evidence.objectEvidenceVersion,'object_evidence_unavailable'],
 ['unknown profile',x=>x.current.observation.profileId='other','object_profile_unknown'],
 ['unknown helper',x=>x.helperHash='f'.repeat(64),'object_helper_unknown'],
 ['missing proof',x=>x.platformProof=null,'object_proof_unavailable'],
 ['unknown proof',x=>x.platformProof.proofId='foreign','object_proof_unknown'],
 ['proof helper mismatch',x=>x.platformProof.helperHash='f'.repeat(64),'object_proof_mismatch'],
 ['proof Windows mismatch',x=>x.platformProof.osVersion='10.0.26100.0','object_proof_mismatch'],
 ['unverified Windows build',x=>x.current.observation.platform.osVersion='10.0.99999.0','object_platform_unsupported'],
 ['non NTFS',x=>x.current.observation.platform.fileSystem='ReFS','object_platform_unsupported'],
 ['network volume',x=>x.current.observation.platform.driveType=4,'object_platform_unsupported'],
 ['reparse target',x=>x.current.observation.file.reparse=true,'object_path_unsupported'],
 ['junction parent',x=>x.current.observation.path.parents[0].reparse=true,'object_path_unsupported'],
 ['multiple hardlinks',x=>x.current.observation.file.links=2,'object_path_unsupported'],
 ['unknown identity',x=>x.current.observation.file.id=null,'object_identity_unavailable'],
 ['ADS unknown',x=>x.current.observation.streams={state:'unavailable',names:null},'object_streams_unavailable'],
 ['named ADS',x=>x.current.observation.streams.names.push(':hidden:$DATA'),'object_streams_unsupported'],
 ['EA unknown',x=>x.current.observation.ea={state:'unavailable',bytes:null},'object_ea_unavailable'],
 ['EA nonempty',x=>x.current.observation.ea.bytes=8,'object_ea_unsupported'],
 ...['owner','group','dacl'].map(k=>['unknown '+k,x=>x.current.observation.security[k]={state:'unavailable',value:null},'object_security_unavailable']),
 ['unapproved attributes',x=>x.current.observation.file.attributes=8192,'object_attributes_unsupported'],
 ['non text',x=>x.current.observation.file.encoding='unsupported','object_text_unsupported'],
 ['too large',x=>x.current.observation.file.bytes=2097153,'object_budget_exceeded'],
 ['created file',x=>x.evidence.beforeRef=null,'object_operation_unsupported'],
 ['rename',x=>x.evidence.operationType='rename','object_operation_unsupported'],
 ['attribution gap',x=>x.current.gapRevision=1,'attribution_gap'],
 ['observed evidence',x=>x.evidence.evidenceLevel='observed','incomplete_evidence'],
 ['tool result unfinished',x=>x.evidence.toolResultObserved=false,'incomplete_evidence'],
 ['reference length mismatch',x=>x.evidence.beforeRef.bytes=1,'incomplete_evidence'],
 ['DACL changed',x=>x.current.observation.security.dacl.value='D:P(A;;FR;;;SY)','object_metadata_changed'],
 ['expired',x=>x.evidence.createdAt=Date.now()-8*86400000,'expired_evidence'],
 ['consumed',x=>x.evidence.consumed=true,'already_reverted'],
 ['new file ID',x=>x.current.observation.file.id='new','object_identity_changed'],
 ['workspace epoch changed',x=>x.current.scope={...scope,workspaceEpoch:'new'},'scope_mismatch'],
 ['runtime generation changed',x=>x.current.scope={...scope,runtimeOwner:{...scope.runtimeOwner,runtimeGeneration:'new'}},'scope_mismatch'],
 ['operation changed',x=>x.current.observation.binding.operationId='other','object_binding_mismatch'],
 ['known SACL cannot carry null',x=>x.current.observation.security.sacl={state:'known',value:null},'object_security_unavailable'],
 ['observation incomplete',x=>x.current.observation.status='unavailable','object_observation_unavailable']
 ];for(const [name,mutate,reason] of cases)await refuse(name,mutate,reason);
 for(const attrs of [32,34,8224,8226])await refuse('Archive candidate '+attrs+' never qualifies',x=>{for(const o of [x.evidence.beforeObjectEvidence,x.evidence.afterObjectEvidence,x.current.observation])o.file.attributes=attrs;},'production_allowlist_empty');
 await refuse('caller cannot enable with approved proof and consent',x=>{x.platformProof.status='approved';x.acknowledged=true;x.platformProof.eligible=true;},'production_allowlist_empty');
 await check('normalizer rejects excessive payload',()=>assert.throws(()=>m.normalizeObjectObservation({value:'x'.repeat(20000)}),e=>e.code==='object_observation_invalid'));
 await check('null and primitive observations have fixed refusals',()=>{for(const value of [null,true,1,'observed'])assert.throws(()=>m.normalizeObjectObservation(value),e=>e.code==='object_observation_invalid');});
 if(process.platform==='win32'){
  const {observeFileObject}=await import('../server/session-revert-object-observer.js');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'p33-object-')),target=path.join(root,'file.txt');
  try{
   const content=Buffer.from('\ufefffixture\r\n');await fs.writeFile(target,content);
   const spec={root,relativePath:'file.txt',scope,operationId:'operation',expectedDigest:hash(content)};
   const first=await observeFileObject(spec);const second=await observeFileObject(spec);
   await check('actual Windows NTFS observe is bounded and does not change file content/object',async()=>{assert.equal(first.status,'observed');assert.equal(first.platform.fileSystem,'NTFS');assert.equal(first.file.id,second.file.id);assert.deepEqual(await fs.readFile(target),content);assert.equal(first.file.digest,hash(content));assert.equal(first.file.links,1);assert.equal(first.file.attributes,second.file.attributes);for(const k of ['owner','group','dacl'])assert.deepEqual(first.security[k],second.security[k]);assert.deepEqual(first.streams,second.streams);assert.deepEqual(first.ea,second.ea);assert.equal(first.source.helperHash,OBJECT_HELPER_HASH);assert.equal(JSON.stringify(first).includes(root),false);});
   await check('actual unavailable SACL is not synthesized empty',()=>{if(first.security.sacl.state!=='known'){assert.equal(first.security.sacl.state,'unavailable');assert.equal(first.security.sacl.value,null);}else assert.equal(typeof first.security.sacl.value,'string');});
   await check('actual stream enumeration and EA empty differ from unknown',()=>{assert.deepEqual(first.streams,{state:'known',names:['::$DATA']});assert.deepEqual(first.ea,{state:'known',bytes:0});});
   await check('real Unicode relative path binds without exposing its absolute path',async()=>{const relativePath='中文 文件😀.txt';await fs.writeFile(path.join(root,relativePath),content);const o=await observeFileObject({...spec,relativePath});assert.equal(o.status,'observed');assert.equal(o.file.digest,hash(content));assert.equal(o.binding.relativePathHash,hash(relativePath));assert.equal(JSON.stringify(o).includes(root),false);});
   await fs.writeFile(target+':hidden','fixture ADS');const ads=await observeFileObject(spec);
   await check('real named ADS is fully enumerated and refused',()=>{assert.ok(ads.streams.names.includes(':hidden:$DATA'));const x=make();x.current.observation.streams=ads.streams;assert.equal(m.evaluateObjectProfile(x).qualification.reason,'object_streams_unsupported');});
   await check('path traversal/ADS inputs never reach native observer',async()=>{for(const relativePath of ['../outside','file.txt:hidden','.git/config'])await assert.rejects(()=>observeFileObject({...spec,relativePath}),e=>e.code==='unsupported_path');});
   console.log('native read-only measurement '+JSON.stringify({osVersion:first.platform.osVersion,architecture:first.platform.architecture,fileSystem:first.platform.fileSystem,idEqual:first.file.id===second.file.id,digest:first.file.digest,bytes:first.file.bytes,attributesEqual:first.file.attributes===second.file.attributes,saclState:first.security.sacl.state,eaState:first.ea.state,eaBytes:first.ea.bytes,streamCount:first.streams.names.length,lastAccessEqual:first.times.lastAccess===second.times.lastAccess,productionEligible:false}));
  }finally{await fs.rm(root,{recursive:true,force:true});}
  await check('actual nonempty EA is observed and rejected without modifying fixture metadata',async()=>{
   const h=require('./session-revert-inplace.cjs');await h.fixture(Buffer.from('EA fixture'),async root=>{
    // Existing TEMP fixture construction only: never invoke its write/commit mode.
    await h.setup(root,'protected',true);const before=await h.observe(root);
    const o=await observeFileObject({root,relativePath:h.relativePath,scope,operationId:'operation',expectedDigest:hash('EA fixture')});const after=await h.observe(root);
    assert.equal(o.ea.state,'known');assert.ok(o.ea.bytes>0);assert.equal(after.ea,before.ea);assert.equal(after.ads,before.ads);assert.equal(after.dacl,before.dacl);assert.equal(after.id,before.id);assert.equal(after.attributes,before.attributes);assert.deepEqual(await fs.readFile(path.join(root,h.relativePath)),Buffer.from('EA fixture'));
    const x=make();x.current.observation.ea=o.ea;assert.equal(m.evaluateObjectProfile(x).qualification.reason,'object_ea_unsupported');
    console.log('native EA negative '+JSON.stringify({eaBytes:o.ea.bytes,eaPreserved:after.ea===before.ea,adsPreserved:after.ads===before.ads,objectPreserved:after.id===before.id}));
   });
  });
 }else{skipped++;console.log('SKIP real Windows NTFS observation');}
 console.log(`Object profile: ${passed}/${passed+failed}; failed=${failed}; skipped=${skipped}; production allowlist empty`);if(failed)process.exitCode=1;
})().catch(e=>{console.error('object profile test failure '+(e.code||e.name));process.exitCode=1;});
