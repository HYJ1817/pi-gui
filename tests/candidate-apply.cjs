const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process'),{randomUUID}=require('node:crypto');let n=0;
const check=async(name,fn)=>{await fn();n++;console.log('ok '+name);};
(async()=>{
 let createCandidateApply;try{({createCandidateApply}=await import('../server/candidate-apply.js'));}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
 await check('controlled candidate apply exists',()=>assert.equal(typeof createCandidateApply,'function'));
 if(process.platform!=='win32'){console.log('SKIP Windows controlled apply');return;}
 const {captureCandidateInput,installCandidateInput,compareCandidateInput}=await import('../lib/candidate-snapshot.js');
 const {observeAdoptionSnapshot,createAdoptionEvidence}=await import('../lib/candidate-adoption.js');const {createWorktrees}=await import('../server/worktrees.js');
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'t4c2-apply-')),root=path.join(world,'source'),data=path.join(world,'data');fs.mkdirSync(root);fs.mkdirSync(data);
 const git=(...a)=>execFileSync('git',a,{cwd:root,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
 git('init','-b','main');git('config','user.name','fixture');git('config','user.email','f@example.invalid');git('config','core.autocrlf','false');fs.writeFileSync(path.join(root,'a.txt'),'base\n');fs.writeFileSync(path.join(root,'delete.txt'),'delete\n');git('add','.');git('commit','-m','base');
 const worktrees=createWorktrees({dataDir:data,getProjects:()=>[{path:root}],getContext:()=>({cwd:root,generation:1})});
 const scope={key:'a'.repeat(64),token:'owner-1',projectRoot:root,assertCurrent(){}};
 async function scenario(){git('reset','--hard','HEAD');if(fs.existsSync(path.join(root,'new.txt')))fs.unlinkSync(path.join(root,'new.txt'));fs.writeFileSync(path.join(root,'a.txt'),'staged\n');git('add','a.txt');fs.writeFileSync(path.join(root,'a.txt'),'working\n');const source=await captureCandidateInput(root),ob=observeAdoptionSnapshot(source);
  const p=await worktrees.prepareCandidate({project:root,source:source.head,branch:'fixture/'+randomUUID()},1),made=await worktrees.createCandidate({nonce:p.nonce},1),workspace=made.workspace;const pre=await installCandidateInput(source,workspace.path),input=observeAdoptionSnapshot(pre);
  fs.writeFileSync(path.join(workspace.path,'a.txt'),'result\n');fs.writeFileSync(path.join(workspace.path,'new.txt'),'new\n');fs.unlinkSync(path.join(workspace.path,'delete.txt'));
  const post=await captureCandidateInput(workspace.path,{includeNew:true}),result={...await compareCandidateInput(pre,post),reliable:true,unconfirmedReasons:[]},run={id:randomUUID(),state:'completed',sourceScope:scope.key,inputId:source.contentId,workspace};return{run,result,adoptionEvidence:createAdoptionEvidence({run,result,source:ob,input,output:observeAdoptionSnapshot(post)})};
 }
 const options={dataDir:data,worktrees,assertIdle(){},protectedRoots:()=>[root]};let app=createCandidateApply(options),saved;
 const until=async predicate=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,20));}throw Error('fixture timeout');};
 const freshData=async()=>{const dir=path.join(world,'data-'+randomUUID());fs.mkdirSync(dir);return dir;};
 try{
  saved=await scenario();let releaseApply;const applyHeld=new Promise(r=>releaseApply=r),first=createCandidateApply({...options,hooks:{beforeStep:async()=>{await applyHeld;}}}),firstPlan=await first.prepare(scope,saved),concurrent=first.confirm(scope,firstPlan.nonce);
  await until(()=>first.busy());const second=createCandidateApply(options);
  await check('second apply instance cannot enter while transaction lock is held',async()=>{await assert.rejects(second.prepare(scope,saved),e=>e.code==='candidate_storage_busy');releaseApply();const done=await concurrent;assert.equal(done.state,'applied');});
  await check('completed apply releases lock for another instance',async()=>{assert.equal(second.status(scope,saved.run.id).state,'applied');await assert.rejects(second.prepare(scope,saved),e=>e.code==='candidate_already_applied');});
  saved=await scenario();const index=fs.readFileSync(path.join(root,'.git/index')),staged=git('ls-files','--stage','-z'),p=await app.prepare(scope,saved);
  await check('preflight returns single-use nonce without source writes',()=>{assert(p.nonce);assert(p.canApply);assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'working\n');});
  await check('wrong owner cannot redeem confirmation',()=>assert.rejects(app.confirm({...scope,token:'owner-2'},p.nonce),e=>e.code==='candidate_expired'));
  const p2=await app.prepare(scope,saved),done=await app.confirm(scope,p2.nonce);
  await check('confirmed whole candidate writes modifies creates deletes',()=>{assert.equal(done.state,'applied');assert.equal(done.files,3);assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'result\n');assert.equal(fs.readFileSync(path.join(root,'new.txt'),'utf8'),'new\n');assert(!fs.existsSync(path.join(root,'delete.txt')));assert.deepEqual(fs.readFileSync(path.join(root,'.git/index')),index);});
  await check('nonce replay refuses',()=>assert.rejects(app.confirm(scope,p2.nonce)));
  await check('restart remembers adoption independently of original run',()=>{app=createCandidateApply(options);assert.equal(app.status(scope,saved.run.id).state,'applied');assert.equal(saved.run.state,'completed');});
  await check('same candidate cannot apply twice',()=>assert.rejects(app.prepare(scope,saved),e=>e.code==='candidate_already_applied'));
  saved=await scenario();const p3=await app.prepare(scope,saved);fs.writeFileSync(path.join(root,'a.txt'),'external D\n');
  await check('source change between prepare and confirm is refused',async()=>{await assert.rejects(app.confirm(scope,p3.nonce));assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'external D\n');});
  saved=await scenario();app=createCandidateApply({...options,hooks:{afterStep(){throw Error('fixture failure');}}});const p4=await app.prepare(scope,saved),partial=await app.confirm(scope,p4.nonce);
  await check('partial multi-file failure never reports success',()=>{assert.equal(partial.state,'recovery_required');assert.equal(partial.files,1);});
  app=createCandidateApply(options);const recovery=await app.prepareRecovery(scope,partial.id);
  await check('failed apply releases lock and restart recovery is a new explicit confirmation',()=>{assert(recovery.nonce);assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'result\n');});
  const recovered=await app.confirmRecovery(scope,recovery.nonce);
  await check('verified recovery restores original working bytes and logical staged index',()=>{assert.equal(recovered.state,'recovered');assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'working\n');assert.equal(git('ls-files','--stage','-z'),staged);});
  await check('consumed recovery confirmation cannot be replayed',()=>assert.rejects(app.confirmRecovery(scope,recovery.nonce),e=>e.code==='candidate_expired'));
  await check('completed recovery cannot prepare a second recovery',()=>assert.rejects(app.prepareRecovery(scope,partial.id),e=>e.code==='candidate_recovery_uncertain'));
  const data2=await freshData();saved=await scenario();app=createCandidateApply({...options,dataDir:data2,hooks:{afterStep(){throw Error('fixture failure');}}});const p5=await app.prepare(scope,saved),partial2=await app.confirm(scope,p5.nonce);fs.writeFileSync(path.join(root,'a.txt'),'new external D\n');app=createCandidateApply({...options,dataDir:data2});
  await check('external changes after failure block recovery without data loss',async()=>{await assert.rejects(app.prepareRecovery(scope,partial2.id));assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'new external D\n');assert.equal(app.status(scope,saved.run.id).state,'recovery_required');});
  const data3=await freshData();saved=await scenario();app=createCandidateApply({...options,dataDir:data3,hooks:{afterStep(){throw Error('fixture failure');}}});const p6=await app.prepare(scope,saved),partial3=await app.confirm(scope,p6.nonce),otherScope={...scope,key:'b'.repeat(64),projectRoot:path.join(world,'other')};
  await check('wrong scope cannot prepare or redeem recovery',async()=>{await assert.rejects(app.prepareRecovery(otherScope,partial3.id),e=>e.code==='candidate_scope');const nonce=await app.prepareRecovery(scope,partial3.id);await assert.rejects(app.confirmRecovery({...scope,token:'owner-2'},nonce.nonce),e=>e.code==='candidate_expired');});
  const data5=await freshData();app=createCandidateApply({...options,dataDir:data5,hooks:{afterStep(){throw Error('fixture failure');}}});saved=await scenario();const p7=await app.prepare(scope,saved),corruptPartial=await app.confirm(scope,p7.nonce),journal=path.join(data5,'candidate-transactions',corruptPartial.id,'000003.json'),beforeCorrupt=fs.readFileSync(journal);
  fs.appendFileSync(journal,'corrupt');
  await check('corrupt recovery material is refused and retained',async()=>{await assert.rejects(createCandidateApply({...options,dataDir:data5}).prepareRecovery(scope,corruptPartial.id),e=>e.code==='candidate_storage_unsafe');assert(fs.readFileSync(journal).subarray(0,beforeCorrupt.length).equals(beforeCorrupt));assert.equal(fs.readFileSync(journal,'utf8').endsWith('corrupt'),true);});
  const data4=await freshData();saved=await scenario();app=createCandidateApply({...options,dataDir:data4,hooks:{afterStep(){throw Error('fixture failure');}}});const p8=await app.prepare(scope,saved),partial4=await app.confirm(scope,p8.nonce);app=createCandidateApply({...options,dataDir:data4,hooks:{afterRecoveryStep(){throw Error('recovery fixture failure');}}});const recovery4=await app.prepareRecovery(scope,partial4.id),recoveryFailed=await app.confirmRecovery(scope,recovery4.nonce);
  await check('recovery failure remains uncertain and blocks automatic retry',async()=>{assert.equal(recoveryFailed.state,'recovery_required');assert.equal(recoveryFailed.uncertain,true);assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'working\n');await assert.rejects(app.prepareRecovery(scope,partial4.id),e=>e.code==='candidate_recovery_uncertain');});
 }finally{await worktrees.dispose?.();fs.rmSync(world,{recursive:true,force:true});}
 console.log(`Candidate apply: ${n}/${n}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
