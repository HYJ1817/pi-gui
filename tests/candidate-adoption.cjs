const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
let passed=0,skipped=0;
const check=async(name,fn)=>{await fn();passed++;console.log('ok '+name);};
(async()=>{
 let api={};try{api=await import('../lib/candidate-adoption.js');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
 await check('read-only adoption API exists',()=>assert.equal(typeof api.checkCandidateAdoption,'function'));
 const {captureCandidateInput,installCandidateInput,compareCandidateInput}=await import('../lib/candidate-snapshot.js');
 const {createWorktrees}=await import('../server/worktrees.js');
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'t4c-adoption-')),root=path.join(world,'source'),data=path.join(world,'data');
 fs.mkdirSync(root);fs.mkdirSync(data);
 const git=(...args)=>execFileSync('git',args,{cwd:root,windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const file=p=>path.join(root,p),write=(p,b)=>fs.writeFileSync(file(p),b);
 git('init','-b','main');git('config','user.name','fixture');git('config','user.email','f@example.invalid');git('config','core.autocrlf','false');
 write('file.txt','base\r\n');write('delete.txt','original delete\n');write('.gitignore','*.private\n');fs.mkdirSync(file('folder'));write('folder/a.txt','untouched\n');git('add','.');git('commit','-m','fixture');
 const manager=createWorktrees({dataDir:data,getProjects:()=>[{path:root}],getContext:()=>({cwd:root,generation:1})});
 const scope={key:'a'.repeat(64),projectRoot:root,assertCurrent(){}};
 const rejects=(saved,code='candidate_source_changed',extra={})=>assert.rejects(api.checkCandidateAdoption({saved,scope,worktrees:manager,assertIdle(){},...extra}),e=>e.code===code);
 let caseNumber=0;
 async function scenario(kind,changed=true){
   git('restore','--staged','--worktree','.');
   if(kind==='staged'||kind==='both'){write('file.txt','staged\r\n');git('add','file.txt');}
   if(kind==='working'||kind==='both')write('file.txt','working\r\n');
   const pre=await captureCandidateInput(root),source=api.observeAdoptionSnapshot(pre);
   const prepared=await manager.prepareCandidate({project:root,source:pre.head,branch:'fixture/adoption-'+(++caseNumber)},1);
   const {workspace}=await manager.createCandidate({nonce:prepared.nonce},1);
   const input=api.observeAdoptionSnapshot(await installCandidateInput(pre,workspace.path));
   if(changed){fs.writeFileSync(path.join(workspace.path,'file.txt'),Buffer.from([0x52,0x0d,0x0a,0xff]));
   fs.writeFileSync(path.join(workspace.path,'new.txt'),'created\n');fs.unlinkSync(path.join(workspace.path,'delete.txt'));}
   const post=await captureCandidateInput(workspace.path,{includeNew:true}),result={...await compareCandidateInput(pre,post),reliable:true,unconfirmedReasons:[]};
   const run={id:randomUUID(),state:'completed',sourceScope:scope.key,inputId:pre.contentId,workspace};
   const saved={run,result,adoptionEvidence:api.createAdoptionEvidence({run,source,input,output:api.observeAdoptionSnapshot(post),result})};
   return {saved,workspace,pre,post};
 }
 try{
   for(const kind of ['clean','working','staged','both']){
     const {saved,pre}=await scenario(kind),index=fs.readFileSync(file('.git/index')),original=fs.readFileSync(file('file.txt'));
     await check(kind+' input checks exact dirty bytes and keeps index unchanged',async()=>{
       const r=await api.checkCandidateAdoption({saved,scope,worktrees:manager,assertIdle(){}});
       assert.equal(r.state,'checked_readonly');assert.equal(r.canApply,false);assert.equal(r.code,'candidate_apply_unavailable');assert(!r.nonce);
       assert.equal(r.plan.files.length,3);assert.equal(r.plan.counts.staged,pre.counts.staged);assert.equal(r.plan.indexEffect,'unchanged');
       assert.deepEqual(fs.readFileSync(file('.git/index')),index);assert.deepEqual(fs.readFileSync(file('file.txt')),original);
     });
     if(kind==='clean')await check('preflight performs no application-side filesystem mutation',async()=>{
       const names=['writeFileSync','mkdirSync','mkdtempSync','renameSync','unlinkSync'],originals=Object.fromEntries(names.map(k=>[k,fs[k]])),open=fs.openSync;
       try{
         for(const k of names)fs[k]=()=>{throw Error('readonly_preflight_wrote');};
         fs.openSync=(p,flags,...args)=>{assert(typeof flags==='number'?!(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_TRUNC)):!/[wa+]/.test(flags));return open(p,flags,...args);};
         assert.equal((await api.checkCandidateAdoption({saved,scope,worktrees:manager,assertIdle(){}})).state,'checked_readonly');
       }finally{Object.assign(fs,originals);fs.openSync=open;}
     });
   }
   let s=await scenario('both'),saved=s.saved;
   await check('observation refuses traversal before filesystem inspection',()=>assert.throws(()=>api.observeAdoptionSnapshot({...s.pre,files:[{...s.pre.files[0],path:'../outside'}]}),e=>e.code==='candidate_unsafe'));
   await check('same status but different bytes conflicts',async()=>{write('file.txt','new user change\r\n');await rejects(saved);write('file.txt','working\r\n');});
   await check('logical staged changes conflict',async()=>{git('add','file.txt');await rejects(saved);});
   s=await scenario('both');saved=s.saved;
   await check('index cache format alone does not change logical input',async()=>{git('update-index','--index-version','4');const r=await api.checkCandidateAdoption({saved,scope,worktrees:manager,assertIdle(){}});assert.equal(r.state,'checked_readonly');});
   await check('new target occupied refuses overwrite',async()=>{write('new.txt','user occupant');await rejects(saved,'candidate_untracked');assert.equal(fs.readFileSync(file('new.txt'),'utf8'),'user occupant');fs.unlinkSync(file('new.txt'));});
   await check('empty directory occupying creation target refuses',async()=>{fs.mkdirSync(file('new.txt'));try{await rejects(saved);}finally{fs.rmdirSync(file('new.txt'));}});
   await check('deleted target with new user content conflicts',async()=>{write('delete.txt','new deletion target');await rejects(saved);write('delete.txt','original delete\n');});
   await check('untracked unrelated file refuses whole run',async()=>{write('extra.txt','extra');await rejects(saved,'candidate_untracked');fs.unlinkSync(file('extra.txt'));});
   await check('ignored input conservatively refuses',async()=>{write('secret.private','do not read');await rejects(saved,'candidate_adoption_ignored');fs.unlinkSync(file('secret.private'));});
   await check('hardlinked target refuses',async()=>{fs.linkSync(file('file.txt'),path.join(world,'hardlink'));try{await rejects(saved,'candidate_unsafe');}finally{fs.unlinkSync(path.join(world,'hardlink'));}});
   await check('junction refuses',async()=>{fs.symlinkSync(data,file('junction'),process.platform==='win32'?'junction':'dir');try{await rejects(saved,'candidate_unsafe');}finally{fs.unlinkSync(file('junction'));}});
   let fileLink=false;try{fs.symlinkSync(file('file.txt'),file('symlink'),'file');fileLink=true;}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;skipped++;console.log('SKIP file symlink: existing token cannot create symbolic links');}
   if(fileLink)await check('file symlink refuses',async()=>{try{await rejects(saved,'candidate_unsafe');}finally{fs.unlinkSync(file('symlink'));}});
   await check('Git lock refuses',async()=>{write('.git/index.lock','fixture');try{await rejects(saved,'candidate_locked');}finally{fs.unlinkSync(file('.git/index.lock'));}});
   await check('filesystem permission mode drift conflicts',async()=>{const mode=fs.statSync(file('file.txt')).mode;fs.chmodSync(file('file.txt'),mode&~0o222);try{await rejects(saved);}finally{fs.chmodSync(file('file.txt'),mode);}});
   await check('parent replacement conflicts even with original file objects',async()=>{
     const retained=path.join(world,'retained-parent');fs.renameSync(file('folder'),retained);fs.mkdirSync(file('folder'));fs.renameSync(path.join(retained,'a.txt'),file('folder/a.txt'));
     try{await rejects(saved);}finally{fs.renameSync(file('folder/a.txt'),path.join(retained,'a.txt'));fs.rmdirSync(file('folder'));fs.renameSync(retained,file('folder'));}
   });
   await check('same-byte source replacement conflicts',async()=>{const b=fs.readFileSync(file('file.txt'));fs.writeFileSync(path.join(world,'replacement'),b);fs.renameSync(path.join(world,'replacement'),file('file.txt'));await rejects(saved);});
   s=await scenario('working');saved=s.saved;
   await check('source HEAD drift conflicts',async()=>{git('commit','--allow-empty','-m','head change');await rejects(saved);});
   s=await scenario('clean');saved=s.saved;
   await check('candidate content changed after result refuses',async()=>{fs.appendFileSync(path.join(s.workspace.path,'file.txt'),'later');await rejects(saved,'candidate_output_changed');});
   s=await scenario('clean');saved=s.saved;
   await check('same-byte candidate replacement refuses',async()=>{const p=path.join(s.workspace.path,'file.txt');fs.writeFileSync(path.join(world,'replacement'),fs.readFileSync(p));fs.renameSync(path.join(world,'replacement'),p);await rejects(saved,'candidate_output_changed');});
   s=await scenario('clean');saved=s.saved;
   const withCurrentOutput=async()=>({...saved,adoptionEvidence:api.createAdoptionEvidence({run:saved.run,source:saved.adoptionEvidence.source,input:saved.adoptionEvidence.input,output:api.observeAdoptionSnapshot(await captureCandidateInput(s.workspace.path,{includeNew:true})),result:saved.result})});
   await check('unconfirmed empty-directory side effect never inherits reliable file diff',async()=>{
     const p=path.join(s.workspace.path,'unexpected-empty');fs.mkdirSync(p);try{await rejects(await withCurrentOutput(),'candidate_adoption_unconfirmed');}finally{fs.rmdirSync(p);}
   });
   await check('candidate parent object replacement during execution refuses',async()=>{
     const p=path.join(s.workspace.path,'folder'),retained=path.join(world,'original-candidate-parent');fs.renameSync(p,retained);fs.mkdirSync(p);fs.renameSync(path.join(retained,'a.txt'),path.join(p,'a.txt'));
     try{await rejects(await withCurrentOutput(),'candidate_adoption_unconfirmed');}finally{fs.renameSync(path.join(p,'a.txt'),path.join(retained,'a.txt'));fs.rmdirSync(p);fs.renameSync(retained,p);}
   });
   await check('candidate Git pointer replacement during execution refuses',async()=>{
     const p=path.join(s.workspace.path,'.git'),retained=path.join(world,'original-git-pointer');fs.renameSync(p,retained);fs.copyFileSync(retained,p);
     try{await rejects(await withCurrentOutput(),'candidate_adoption_unconfirmed');}finally{fs.unlinkSync(p);fs.renameSync(retained,p);}
   });
   await check('old retained record lacks safe adoption evidence',()=>rejects({...saved,adoptionEvidence:undefined},'candidate_adoption_unsupported'));
   await check('corrupt or future evidence does not regain eligibility',async()=>{for(const change of [{version:2},{digest:'0'.repeat(64)}])await rejects({...saved,adoptionEvidence:{...saved.adoptionEvidence,...change}},'candidate_adoption_unsupported');});
   await check('completed is insufficient without reliable evidence',()=>rejects({...saved,result:{...saved.result,reliable:false}},'candidate_adoption_ineligible'));
   await check('unconfirmed effects refuse',()=>rejects({...saved,result:{...saved.result,unconfirmedReasons:['unknown_tool']}},'candidate_adoption_ineligible'));
   await check('all non-completed states refuse',async()=>{for(const state of ['pending','running','failed','stopped','interrupted'])await rejects({...saved,run:{...saved.run,state}},'candidate_adoption_ineligible');});
   await check('truncated Diff refuses',()=>rejects({...saved,result:{...saved.result,truncated:true}},'candidate_adoption_ineligible'));
   await check('historical Diff tampering refuses',()=>rejects({...saved,result:{...saved.result,files:saved.result.files.slice(1)}},'candidate_adoption_unsupported'));
   await check('qualification cannot be upgraded independently of frozen evidence',()=>{
     const unqualified={...saved.result,reliable:false,unconfirmedReasons:['unknown_tool']},e=api.createAdoptionEvidence({run:saved.run,source:saved.adoptionEvidence.source,input:saved.adoptionEvidence.input,output:saved.adoptionEvidence.output,result:unqualified});
     return rejects({...saved,adoptionEvidence:e},'candidate_adoption_unsupported');
   });
   await check('terminal state cannot be upgraded independently of frozen evidence',()=>{
     const e=api.createAdoptionEvidence({run:{...saved.run,state:'stopped'},source:saved.adoptionEvidence.source,input:saved.adoptionEvidence.input,output:saved.adoptionEvidence.output,result:saved.result});
     return rejects({...saved,adoptionEvidence:e},'candidate_adoption_unsupported');
   });
   await check('oversize optional evidence refuses before persistence',()=>assert.throws(()=>api.createAdoptionEvidence({run:saved.run,source:{padding:'x'.repeat(1024*1024)},output:{},result:saved.result}),e=>e.code==='candidate_adoption_unsupported'));
   await check('source scope mismatch refuses',()=>rejects(saved,'candidate_scope',{scope:{...scope,key:'b'.repeat(64)}}));
   await check('same repository other Worktree cannot become source',()=>rejects(saved,'candidate_scope',{scope:{...scope,projectRoot:s.workspace.path}}));
   await check('owner change during awaited validation refuses',async()=>{let calls=0;await rejects(saved,'fixture_stale',{scope:{...scope,assertCurrent(){if(++calls>1)throw Object.assign(Error('stale'),{code:'fixture_stale'});}}});});
   await check('busy Stop or tool operation refuses',()=>rejects(saved,'candidate_busy',{assertIdle(){throw Object.assign(Error('busy'),{code:'candidate_busy'});}}));
   await check('repeat checks never apply or mutate historical result',async()=>{const before=JSON.stringify(saved);for(let i=0;i<2;i++){const r=await api.checkCandidateAdoption({saved,scope,worktrees:manager,assertIdle(){}});assert.equal(r.canApply,false);assert(!r.nonce);}assert.equal(JSON.stringify(saved),before);});
   await check('Git admin and common object replacement conflicts',async()=>{
     const originalAdmin=path.join(world,'original-admin'),admin=file('.git');fs.renameSync(admin,originalAdmin);fs.cpSync(originalAdmin,admin,{recursive:true});
     try{await rejects(saved);}finally{const relative=path.relative(fs.realpathSync(world),fs.realpathSync(admin));assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(admin,{recursive:true});fs.renameSync(originalAdmin,admin);}
   });
   await check('missing candidate refuses',async()=>{fs.renameSync(s.workspace.path,s.workspace.path+'-retained');await assert.rejects(api.checkCandidateAdoption({saved,scope,worktrees:manager,assertIdle(){}}));});
   s=await scenario('clean',false);
   await check('completed empty delta has no adoption operation',()=>rejects(s.saved,'candidate_adoption_empty'));
 }finally{
   manager.dispose();const resolved=fs.realpathSync(world),relative=path.relative(fs.realpathSync(os.tmpdir()),resolved);assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
 console.log(`Candidate adoption: ${passed}/${passed}; failed=0; skipped=${skipped}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
