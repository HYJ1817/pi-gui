const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const h=require('./fixtures/session-revert-object-harness.cjs'),old=require('./session-revert-inplace.cjs');
const {compareWitness}=require('./session-revert-sacl-witness.cjs');
const matrix=['explicit','inherited','protected','mixed'].flatMap(auditProfile=>['protected','inherited'].map(metadataKind=>({auditProfile,metadataKind})));
async function runWitness(){
 const helper=await fs.readFile(path.join(h.base,'server/session-revert-object-write-native.ps1'));
 const result={version:1,tool:'p33-d2-object-witness',helperHash:h.hash(helper),targetAccessMask:'0x12008b',apis:['CreateFileW','GetFileInformationByHandle','ReadFile','WriteFile','SetFilePointerEx','SetEndOfFile','FlushFileBuffers'],productionQualified:false,passed:0,failed:0,skipped:0,cases:[]};
 let probe;
 if(process.platform==='win32')await h.fixture(Buffer.from('audit probe'),async root=>{const {observeFileObject}=await import('../server/session-revert-object-observer.js');probe=await observeFileObject({root,relativePath:'workspace/file.txt',scope:h.scope,operationId:'probe'});result.osVersion=probe.platform?.osVersion;result.fileSystem=probe.platform?.fileSystem;});
 if(probe?.security?.sacl?.state!=='known'){result.reason='existing_token_sacl_unavailable';result.skipped=8;result.cases=matrix.map(spec=>({...spec,status:'unverified',stage:'privilege',reason:result.reason}));return result;}
 for(const spec of matrix){const row={...spec,status:'failed',stage:'setup'};
  try{await h.fixture(Buffer.from('witness C\r\n'),async(root,attempts)=>{
   // Old tool constructs/observes metadata only. Its write method is never called.
   const before=await old.one({root,relativePath:old.relativePath,mode:'sacl_setup',...spec,withExtras:true});assert.equal(compareWitness(before,before,spec).matched,true);
   const C=Buffer.from('witness C\r\n'),R=Buffer.from('witness R\n');row.stage='new_writer_ready';
   const m=await h.prepare(root,C,R,{extras:true}),a=await m.open(m.args);attempts.push(a);assert.equal(a.ready.saclState,'known');row.stage='C_to_R';const first=await a.commit(m.binding(a));assert.equal(first.status,'verified');
   const after=await old.observe(root);row.stage='compare_R';row.checks=compareWitness(before,after,spec).checks;assert.equal(Object.values(row.checks).every(Boolean),true);
   const reopened=await m.reopen();const savedC=await reopened.restoreRead(h.scope,m.currentRef);assert.deepEqual(savedC,C);row.stage='restore_from_material';
   const second=await h.prepare(root,R,savedC,{extras:true}),b=await second.open(second.args);attempts.push(b);assert.equal((await b.commit(second.binding(b))).status,'verified');
   row.stage='compare_C';row.restoreChecks=compareWitness(before,await old.observe(root),spec).checks;assert.equal(Object.values(row.restoreChecks).every(Boolean),true);assert.deepEqual(await fs.readFile(path.join(root,old.relativePath)),C);
   row.currentDigest=h.hash(savedC);row.candidateDigest=h.hash(await reopened.restoreRead(h.scope,m.candidateRef));row.status='passed';row.stage='complete';row.backupVerified=true;row.coreHelperHash=a.helperHash;assert.equal(a.helperHash,result.helperHash);
  });result.passed++;}catch(e){result.failed++;row.reason='new_writer_witness_failed';row.failureKind=e.code==='ERR_ASSERTION'?'assertion':'operation';}result.cases.push(row);
 }
 return result;
}
module.exports={runWitness};
if(require.main===module)(async()=>{const args=process.argv.slice(2);if(args.some(a=>a!=='--require-audit')||args.length>1)throw Error('invalid_arguments');const r=await runWitness();console.log(JSON.stringify(r));console.log(`Object witness: ${r.passed}/${r.passed+r.failed}; failed=${r.failed}; skipped=${r.skipped}`);if(r.failed||args.includes('--require-audit')&&r.skipped)process.exitCode=r.failed?1:2;})().catch(()=>{console.error('witness_unavailable');process.exitCode=1;});
