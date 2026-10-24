/* Real transaction storage and TEMP Git; both failures precede native writes. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
(async()=>{
 const {createCandidateApply}=await import('../server/candidate-apply.js');
 const {createCandidateTransactions}=await import('../server/candidate-transactions.js');
 const {captureCandidateInput,candidateHash}=await import('../lib/candidate-snapshot.js');
 const {observeAdoptionSnapshot}=await import('../lib/candidate-adoption.js');
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'candidate-recovery-errors-'));
 const root=path.join(world,'source'),data=path.join(world,'data');fs.mkdirSync(root);fs.mkdirSync(data);
 const git=(...args)=>execFileSync('git',args,{cwd:root,windowsHide:true,stdio:'pipe'});
 let passed=0;const check=async(name,fn)=>{await fn();passed++;console.log('ok '+name);};
 try{
  git('init','-b','main');git('config','user.name','fixture');git('config','user.email','fixture@example.invalid');git('config','core.autocrlf','false');
  const target=path.join(root,'file.txt'),original=Buffer.from('original\n'),current=Buffer.from('partial applied\n');
  fs.writeFileSync(target,original);git('add','.');git('commit','-m','fixture');
  const before=await captureCandidateInput(root),scope={key:'a'.repeat(64),token:'owner',projectRoot:root,assertCurrent(){}};
  const store=createCandidateTransactions({dataDir:data}),lock=store.acquire();let tx;
  try{tx=store.create({binding:{scope:scope.key,source:root,runId:randomUUID(),sourceObservation:observeAdoptionSnapshot(before)},plan:{inputId:before.contentId},files:[{path:'file.txt',before:candidateHash(original),after:candidateHash(current),original:original.toString('base64')}]});
   fs.writeFileSync(target,current);store.append(tx.id,{state:'step_verified',step:0,result:{index:0,identity:fs.statSync(target,{bigint:true}).ino.toString()}});store.append(tx.id,{state:'recovery_required',uncertain:false});
  }finally{lock.release();}
  const app=createCandidateApply({dataDir:data,assertIdle(){}}),plan=await app.prepareRecovery(scope,tx.id);
  const journal=()=>fs.readdirSync(tx.directory).sort().map(name=>[name,fs.readFileSync(path.join(tx.directory,name)).toString('base64')]);
  const saved=journal(),index=fs.readFileSync(path.join(root,'.git/index'));
  const held=store.acquire();
  try{await check('lock acquisition failure preserves original storage error without transaction or writes',async()=>{
   await assert.rejects(app.confirmRecovery(scope,plan.nonce),e=>e.code==='candidate_storage_busy'&&!(e instanceof TypeError));
   assert.deepEqual(journal(),saved);assert.deepEqual(fs.readFileSync(target),current);assert.deepEqual(fs.readFileSync(path.join(root,'.git/index')),index);assert.equal(app.busy(),false);
  });}finally{held.release();}
  await check('failed lock confirmation remains single use',()=>assert.rejects(app.confirmRecovery(scope,plan.nonce),{code:'candidate_expired'}));
  const again=await app.prepareRecovery(scope,tx.id),first=path.join(tx.directory,'000000.json');fs.appendFileSync(first,'corrupt');const corrupt=journal();
  await check('transaction read failure preserves storage error and corrupt evidence',async()=>{
   await assert.rejects(app.confirmRecovery(scope,again.nonce),e=>e.code==='candidate_storage_unsafe'&&!(e instanceof TypeError));
   assert.deepEqual(journal(),corrupt);assert.deepEqual(fs.readFileSync(target),current);assert.equal(app.busy(),false);
   assert.equal(fs.existsSync(path.join(data,'candidate-transactions','execute.lock')),false);
  });
  console.log(`Candidate recovery errors: ${passed}/${passed}; failed=0; skipped=0`);
 }finally{fs.rmSync(world,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
