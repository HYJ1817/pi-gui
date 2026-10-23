const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');let n=0;
const check=async(name,fn)=>{await fn();n++;console.log('ok '+name);};
const waitFor=async(test,label)=>{for(let i=0;i<1200;i++){if(test())return;await new Promise(r=>setTimeout(r,50));}throw Error('Fixture wait expired: '+label);};
(async()=>{
 let createCandidateRuns;try{({createCandidateRuns}=await import('../server/candidate-runs.js'));}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
 await check('candidate controller exists',()=>assert.equal(typeof createCandidateRuns,'function'));
 const {createWorktrees}=await import('../server/worktrees.js');
 const {lineHash}=await import('../public/diff.js');
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'t4b-runs-')),root=path.join(fixture,'repo'),data=path.join(fixture,'data');fs.mkdirSync(root);fs.mkdirSync(data);
 const git=(...a)=>execFileSync('git',a,{cwd:root,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
 git('init','-b','main');git('config','user.name','fixture');git('config','user.email','f@example.invalid');git('config','core.autocrlf','false');fs.writeFileSync(path.join(root,'file.txt'),'base\n');git('add','.');git('commit','-m','base');fs.writeFileSync(path.join(root,'file.txt'),'dirty\n');
 const manager=createWorktrees({dataDir:data,getProjects:()=>[{path:root}],getContext:()=>({cwd:root,generation:1})});
 const scope={key:'a'.repeat(64),projectRoot:root,gitCommon:path.join(root,'.git'),assertCurrent(){if(stale)throw Error('stale');}};let stale=false,sends=0,live=null,controller,closeGate=null,closing=false,closeHook=null;
 const row={id:'comment',path:'file.txt',text:'change fixture',createdAt:1,updatedAt:1,anchor:{path:'file.txt',section:'working',type:'add',oldLine:null,newLine:1,hunkIndex:0,hunkHeader:lineHash('@@ -1 +1 @@'),codeHash:lineHash('dirty'),diffFingerprint:'00000000'}};
 let revision='11111111-1111-4111-8111-111111111111';
 const registry={snapshot:()=>({items:live?[{owner:live.owner,lifecycle:'ready',activity:live.active?'running':'idle',conversationId:live.owner.conversationId}]:[],totalCount:0}),getOwner:()=>live?.owner,
  getAdapter:()=>({toolGuard:{assertReady:async()=>{}},getState:()=>({state:'ready',stop:{pending:false}})}),
  async start(args){if(sends===0&&process.env.T4B_FIXTURE_START_DELAY_MS)await new Promise(r=>setTimeout(r,Math.min(10000,Number(process.env.T4B_FIXTURE_START_DELAY_MS)||0)));await manager.withWorkspace(args,w=>{live={root:w.root,active:false,owner:{conversationId:'candidate-conversation',sessionId:'candidate-native',workspaceId:w.workspaceId,workspaceEpoch:w.workspaceEpoch}};});return{owner:live.owner,conversationId:live.owner.conversationId};},
  read:async()=>({sessionId:'candidate-native',isStreaming:false}),
  async command(owner,cmd){assert.equal(owner,live.owner);if(cmd.type==='abort'){live.active=false;return{ok:true};}sends++;live.active=true;},
  close:async()=>{closing=true;if(closeGate)await closeGate;if(closeHook)closeHook(live);live=null;},busy:()=>false};
 const options={dataDir:data,worktrees:manager,registry,readComments:()=>({revision,comments:[row]}),projectFor:()=>root,contextGeneration:()=>1,busy:()=>false,protectedRoots:()=>[root]};
 controller=createCandidateRuns(options);
 const body={selectedIds:['comment'],revision,scope:scope.key};
 let originalFailure=null;try{
  await check('candidate controller exposes a read-only adoption check',()=>assert.equal(typeof controller.checkAdoption,'function'));
  const plan=await controller.prepare(scope,body,{conversationId:'source',sessionId:'native'});
  await check('preflight creates no worktree or Agent',()=>{assert.equal(sends,0);assert(!fs.existsSync(path.join(data,'worktrees')));assert(plan.nonce);});
  let retired=false;const previousScope={...scope,token:'owner-A',assertCurrent(){if(retired)throw Error('old owner');}};
  const oldOwnerPlan=await controller.prepare(previousScope,body,{conversationId:'source',sessionId:'native'});retired=true;
  const realCreate=manager.createCandidate;manager.createCandidate=async()=>{throw Object.assign(Error('old nonce reached create'),{code:'old_nonce_reached_create'});};
  try{await check('new owner cannot redeem nonce from same persistent scope',()=>assert.rejects(controller.confirm({...scope,token:'owner-B'},oldOwnerPlan.nonce),e=>e.code==='candidate_expired'));}finally{manager.createCandidate=realCreate;}
  const cancelled=await controller.prepare(scope,body,{conversationId:'source',sessionId:'native'});
  await check('cancelled preflight nonce cannot execute later',async()=>{await controller.cancel(scope,cancelled.nonce);await assert.rejects(controller.confirm(scope,cancelled.nonce),e=>e.code==='candidate_expired');assert.equal(sends,0);});
  fs.writeFileSync(path.join(root,'file.txt'),'other\n');
  await check('same status content drift rejects confirmation',()=>assert.rejects(controller.confirm(scope,plan.nonce),e=>e.code==='candidate_changed'));
  fs.writeFileSync(path.join(root,'file.txt'),'dirty\n');
  const next=await controller.prepare(scope,body,{conversationId:'source',sessionId:'native'});
  const run=await controller.confirm(scope,next.nonce);
  await check('confirmed action sends exactly once',async()=>{await waitFor(()=>sends>=1,'first prompt');assert.equal(sends,1);assert.equal(fs.readFileSync(path.join(live.root,'file.txt'),'utf8'),'dirty\n');});
  await check('nonce replay cannot create or send again',()=>assert.rejects(controller.confirm(scope,next.nonce)));
  await check('source bytes remain unchanged',()=>assert.equal(fs.readFileSync(path.join(root,'file.txt'),'utf8'),'dirty\n'));
  // A read-only Git query may refresh stat/cache bytes or rewrite the index
  // format without changing any logical staged entries or working content.
  execFileSync('git',['update-index','--index-version','4'],{cwd:live.root,windowsHide:true,stdio:'ignore'});
  await controller.audit(live.owner,{phase:'begin',callId:'call',audit:{kind:'write',path:'file.txt',expectedHash:require('node:crypto').createHash('sha256').update('result\n').digest('hex')}});
  fs.writeFileSync(path.join(live.root,'file.txt'),'result\n');
  await controller.audit(live.owner,{phase:'end',callId:'call'});live.active=false;
  await controller.audit(live.owner,{phase:'begin',callId:'read',audit:{kind:'read',path:null,expectedHash:null}});
  const replaced=path.join(fixture,'replacement');fs.writeFileSync(replaced,'result\n');fs.renameSync(replaced,path.join(live.root,'file.txt'));
  await controller.audit(live.owner,{phase:'end',callId:'read'});
  let releaseCleanup;closeGate=new Promise(r=>{releaseCleanup=r;});
  const settled=controller.observe({type:'runtime_event',owner:live.owner,event:{type:'agent_settled'}});
  await waitFor(()=>closing,'cleanup entered');
  await check('unconfirmed runtime cleanup cannot advertise completion',()=>{try{assert.notEqual(controller.get(scope,run.run.id).run.state,'completed');}finally{releaseCleanup();closeGate=null;}});
  await settled;
  const finished=controller.get(scope,run.run.id);
  await check('true completion and actual disk diff',()=>{assert.equal(finished.run.state,'completed');assert.match(finished.result.files[0].patch,/-dirty/);assert.match(finished.result.files[0].patch,/\+result/);});
  await check('read-only tool cannot hide same-byte file identity replacement',()=>assert.equal(finished.result.reliable,false));
  await check('index cache or format alone is not a source-code change',()=>assert(!finished.result.unconfirmedReasons.includes('unbracketed_change')));
  await check('closing view does not delete candidate',()=>assert(fs.existsSync(finished.run.workspace.path)));
  const reopened=createCandidateRuns(options);
  await check('restart recovers retained actual result without sending',()=>{assert.equal(reopened.get(scope,run.run.id).run.state,'completed');assert.equal(sends,1);});
  await check('cross scope cannot read result',()=>assert.throws(()=>reopened.get({...scope,key:'b'.repeat(64)},run.run.id)));
  const editedPlan=await controller.prepare(scope,body,{conversationId:'source',sessionId:'native'});
  revision='22222222-2222-4222-8222-222222222222';
  await check('comment revision change refuses old nonce',()=>assert.rejects(controller.confirm(scope,editedPlan.nonce),e=>e.code==='candidate_comments_changed'));
  body.revision=revision;
  const stoppedPlan=await controller.prepare(scope,body,{conversationId:'source',sessionId:'native'});
  const stoppedRun=await controller.confirm(scope,stoppedPlan.nonce);
  await waitFor(()=>sends>=2,'second prompt');
  const retainedRoot=live.root;
  const duringRestart=createCandidateRuns(options);
  await check('restart labels live historical record interrupted without resend',()=>{assert.equal(duringRestart.get(scope,stoppedRun.run.id).run.state,'interrupted');assert.equal(sends,2);});
  const otherPlan=await duringRestart.prepare(scope,body,{conversationId:'source',sessionId:'native'});
  await check('cross instance lock blocks second start',()=>assert.rejects(duringRestart.confirm(scope,otherPlan.nonce),e=>e.code==='candidate_storage_busy'));
  const stopped=await controller.stop(scope,stoppedRun.run.id);
  await check('Stop uses existing abort and preserves candidate',()=>{assert.equal(stopped.run.state,'stopped');assert(fs.existsSync(retainedRoot));assert.equal(sends,2);});
  const externalPlan=await controller.prepare(scope,body,{conversationId:'source',sessionId:'native'});
  const externalRun=await controller.confirm(scope,externalPlan.nonce);
  await waitFor(()=>sends>=3,'third prompt');
  const externalOwner=live.owner;fs.writeFileSync(path.join(live.root,'file.txt'),'external\n');live.active=false;
  await controller.observe({type:'runtime_event',owner:externalOwner,event:{type:'agent_settled'}});
  const uncertain=controller.get(scope,externalRun.run.id);
  await check('external unbracketed write cannot become reliable result',()=>{assert.equal(uncertain.result.reliable,false);assert.match(uncertain.result.notice,/无法可靠确认/);assert.match(uncertain.result.files[0].patch,/external/);});
  const unknownPlan=await controller.prepare(scope,body,{conversationId:'source',sessionId:'native'});
  const unknownRun=await controller.confirm(scope,unknownPlan.nonce);
  await waitFor(()=>sends>=4,'fourth prompt');
  const unknownOwner=live.owner;
  await controller.audit(unknownOwner,{phase:'begin',callId:'shell',audit:{kind:'unknown',path:null,expectedHash:null}});
  fs.writeFileSync(path.join(live.root,'file.txt'),'shell result\n');
  await controller.audit(unknownOwner,{phase:'end',callId:'shell'});live.active=false;
  await controller.observe({type:'runtime_event',owner:unknownOwner,event:{type:'agent_settled'}});
  await check('unknown tool does not bypass result qualification',()=>assert.equal(controller.get(scope,unknownRun.run.id).result.reliable,false));
  const crashPlan=await controller.prepare(scope,body,{conversationId:'source',sessionId:'native'});
  const crashRun=await controller.confirm(scope,crashPlan.nonce);
  await waitFor(()=>sends>=5,'fifth prompt');
  await controller.observe({type:'runtime_state',owner:live.owner,item:{lifecycle:'error'}});
  await check('RPC crash cannot be completed',()=>assert.equal(controller.get(scope,crashRun.run.id).run.state,'interrupted'));
  const barrierPlan=await controller.prepare(scope,body,{conversationId:'source',sessionId:'native'});
  const barrierRun=await controller.confirm(scope,barrierPlan.nonce);
  await waitFor(()=>sends>=6,'sixth prompt');
  const barrierOwner=live.owner;live.active=false;
  await controller.observe({type:'runtime_event',owner:barrierOwner,event:{type:'stop_state',pending:true}});
  await controller.observe({type:'runtime_event',owner:barrierOwner,event:{type:'agent_settled'}});
  await check('settled cannot bypass the existing pending Stop barrier',()=>assert.equal(controller.get(scope,barrierRun.run.id).run.state,'running'));
  await controller.observe({type:'runtime_event',owner:barrierOwner,event:{type:'stop_state',pending:false}});
  await check('authoritative Stop confirmation closes as stopped',()=>assert.equal(controller.get(scope,barrierRun.run.id).run.state,'stopped'));
  const cleanupPlan=await controller.prepare(scope,body,{conversationId:'source',sessionId:'native'});
  const cleanupRun=await controller.confirm(scope,cleanupPlan.nonce);
  await waitFor(()=>sends>=7,'seventh prompt');
  closeHook=current=>fs.writeFileSync(path.join(current.root,'file.txt'),'late cleanup write\n');
  await controller.observe({type:'runtime_event',owner:live.owner,event:{type:'agent_settled'}});closeHook=null;
  await check('result includes late cleanup writes and refuses their attribution',()=>{const result=controller.get(scope,cleanupRun.run.id).result;assert.match(result.files[0]?.patch||'',/late cleanup write/);assert.equal(result.reliable,false);});
  const qualifiedPlan=await controller.prepare(scope,body,{conversationId:'source',sessionId:'native'}),qualifiedRun=await controller.confirm(scope,qualifiedPlan.nonce);
  await waitFor(()=>sends>=8,'qualified prompt');const qualifiedOwner=live.owner;
  await controller.audit(qualifiedOwner,{phase:'begin',callId:'qualified',audit:{kind:'write',path:'file.txt',expectedHash:require('node:crypto').createHash('sha256').update('qualified result\n').digest('hex')}});
  fs.writeFileSync(path.join(live.root,'file.txt'),'qualified result\n');await controller.audit(qualifiedOwner,{phase:'end',callId:'qualified'});live.active=false;
  await controller.observe({type:'runtime_event',owner:qualifiedOwner,event:{type:'agent_settled'}});
  const recordFile=path.join(data,'candidate-runs',qualifiedRun.run.id+'.json'),historical=fs.readFileSync(recordFile),history=JSON.parse(historical),sourceIndex=fs.readFileSync(path.join(root,'.git/index'));
  await check('new reliable history persists original source and actual output identities',()=>{assert.equal(history.result.reliable,true);assert.equal(history.adoptionEvidence.source.root,root);assert.equal(history.adoptionEvidence.output.root,history.run.workspace.path);assert(history.adoptionEvidence.digest);});
  await check('trusted run checks read-only without changing source index or history',async()=>{const r=await controller.checkAdoption(scope,qualifiedRun.run.id);assert.equal(r.state,'checked_readonly');assert.equal(r.canApply,false);assert(!r.nonce);assert.deepEqual(fs.readFileSync(recordFile),historical);assert.deepEqual(fs.readFileSync(path.join(root,'.git/index')),sourceIndex);assert.equal(fs.readFileSync(path.join(root,'file.txt'),'utf8'),'dirty\n');});
  const restoredController=createCandidateRuns(options);
  await check('restart retains new evidence and never replays Agent',async()=>{assert.equal((await restoredController.checkAdoption(scope,qualifiedRun.run.id)).state,'checked_readonly');assert.equal(sends,8);});
  await check('concurrent checks have a backend single-flight gate',async()=>{const first=controller.checkAdoption(scope,qualifiedRun.run.id);await assert.rejects(controller.checkAdoption(scope,qualifiedRun.run.id),e=>e.code==='candidate_busy');assert.equal((await first).canApply,false);});
  const {createCandidateStore}=await import('../server/candidate-store.js'),locker=createCandidateStore({dataDir:data});locker.acquire();
  try{await check('unresolved cross-instance writer lock refuses checks without deletion',()=>assert.rejects(restoredController.checkAdoption(scope,qualifiedRun.run.id),e=>e.code==='candidate_storage_busy'));}finally{locker.release();}
  await check('source conflict preserves newer bytes and original candidate history',async()=>{fs.writeFileSync(path.join(root,'file.txt'),'new user bytes\n');try{await assert.rejects(restoredController.checkAdoption(scope,qualifiedRun.run.id),e=>e.code==='candidate_source_changed');assert.equal(fs.readFileSync(path.join(root,'file.txt'),'utf8'),'new user bytes\n');assert.deepEqual(fs.readFileSync(recordFile),historical);}finally{fs.writeFileSync(path.join(root,'file.txt'),'dirty\n');}});
  await check('legacy and future supplemental evidence remain viewable but never adoptable',async()=>{try{for(const e of [undefined,{version:99}]){const value=JSON.parse(historical);value.adoptionEvidence=e;fs.writeFileSync(recordFile,JSON.stringify(value));const legacy=createCandidateRuns(options);assert.equal(legacy.get(scope,qualifiedRun.run.id).result.reliable,true);await assert.rejects(legacy.checkAdoption(scope,qualifiedRun.run.id),err=>err.code==='candidate_adoption_unsupported');}}finally{fs.writeFileSync(recordFile,historical);}});
  const stalePlan=await controller.prepare(scope,body,{conversationId:'source',sessionId:'native'});stale=true;
  await check('source owner change refuses confirmation',()=>assert.rejects(controller.confirm(scope,stalePlan.nonce)));
  stale=false;
 }catch(e){originalFailure=e;console.error('Original candidate fixture failure:',e.code||e.message);throw e;}finally{
  await controller.dispose();
  try{await waitFor(()=>!controller.busy(),'pending fixture execution drained');}catch(e){if(!originalFailure)throw e;}
  manager.dispose();
  if(!controller.busy()){
   const resolved=fs.realpathSync(fixture),rel=path.relative(fs.realpathSync(os.tmpdir()),resolved);assert(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));
   try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(e){if(!originalFailure)throw e;console.error('Owned temporary fixture retained; original failure preserved');}
  }
 }
 console.log(`Candidate runs: ${n}/${n}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
