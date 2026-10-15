const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./fixtures/session-revert-object-runtime-harness.cjs');
let checks=0;const check=async(name,fn)=>{await fn();checks++;console.log('ok '+name);};
(async()=>{
 if(process.platform==='win32')await check('Aliased TEMP canonicalizes the fixture before actual Classic scope binding',async()=>{
  const os=require('node:os'),{canonicalPath}=await import('../lib/safe-path.js'),tempRoot=canonicalPath(os.tmpdir()),root=fs.mkdtempSync(path.join(tempRoot,'p33-runtime-alias-')),alias=path.join(root,'alias');
  fs.symlinkSync(tempRoot,alias,'junction');const saved={TEMP:process.env.TEMP,TMP:process.env.TMP,TMPDIR:process.env.TMPDIR};
  try{process.env.TEMP=alias;process.env.TMP=alias;process.env.TMPDIR=alias;await fixture(async x=>{assert.equal(x.root,canonicalPath(x.root));assert.equal(path.dirname(x.root),tempRoot);const classic=await x.classicSession(),object=await x.objectService(classic.owner(),{classic});assert.equal(object.opens,0);assert.equal(object.commits,0);});}
  finally{for(const [key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;assert.equal(path.dirname(root),tempRoot);assert.match(path.basename(root),/^p33-runtime-alias-/);fs.unlinkSync(alias);fs.rmdirSync(root);}
 });
 await fixture(async x=>{
  const {createSessionRevertAdmission}=await import('../server/session-revert-admission.js');
  await check('Admission refuses same-path root object replacement using BigInt identity',()=>{
   const target=path.join(x.root,'replace-root');fs.mkdirSync(target);const gate=createSessionRevertAdmission(),lease=gate.acquire(target);
   fs.renameSync(target,target+'-old');fs.mkdirSync(target);
   assert.throws(()=>lease.assertCurrent(target),{code:'stale_revert_token'});lease.release();gate.assertAllowed(target);
  });
  const a=await x.start(x.a),b=await x.start(x.b),before=x.baseline();
  await check('Actual Registry/Worktrees/fakePi guardian owns distinct sessions and keeps same-workspace exclusion',async()=>{
   assert.notEqual(a.sessionId,b.sessionId);assert.equal(x.children.length,2);assert.equal((await x.registry.read(a,{type:'get_state'})).sessionId,a.sessionId);
   await assert.rejects(x.registry.start({id:x.a.id,epoch:x.a.epoch}),{code:'workspace_in_use'});
  });
  const {createSessionRevertAuthority,createSessionRevertMutationAuthority}=await import('../server/session-revert-authority.js');
  const {createSessionRevertObjectRuntimeAuthority,createSessionRevertStopAndDrain}=await import('../server/session-revert-object-runtime-authority.js');
  const baseAuthority=createSessionRevertAuthority({registry:x.registry,worktrees:x.worktrees}),objectAuthority=createSessionRevertObjectRuntimeAuthority({withAuthority:baseAuthority,registry:x.registry});
  const body={owner:a,conversationId:a.conversationId};
  await check('B authority reuses actual Changes bridge/RPC/worktree and rejects dormant or unfocused owner',async()=>{
   await assert.rejects(objectAuthority({},body,()=>assert.fail()),{code:'stale_runtime'});await x.registry.focus(a);
   const proof=await objectAuthority({},body,async authority=>{await authority.revalidate();assert.equal(authority.root,x.a.path);return authority.scope;});
   assert.deepEqual(proof.runtimeOwner,a);assert.equal(proof.nativeSessionId,a.sessionId);assert.match(proof.workspaceFingerprint,/^[0-9a-f]{64}$/);
   await assert.rejects(objectAuthority({},{owner:b,conversationId:b.conversationId},()=>assert.fail()),{code:'stale_runtime'});
  });
  await check('Retained authority rejects focus A to B to A despite identical final owner',async()=>{
   const authority=await objectAuthority({},body,value=>value);await x.registry.focus(b);await x.registry.focus(a);
   await assert.rejects(authority.revalidate(),{code:'stale_runtime'});
  });
  await check('Real Stop/drain runs after Worktrees lifecycle release and aborts only the matching physical root',async()=>{
   let lifecycleHeld=false,stops=0;
   const withAuthority=(req,request,action)=>objectAuthority(req,request,async authority=>{assert.equal(lifecycleHeld,false);lifecycleHeld=true;try{return await action(authority);}finally{lifecycleHeld=false;}});
   const stop=createSessionRevertStopAndDrain({admission:x.admission,registry:x.registry,worktrees:x.worktrees,classic:{root:()=>null}});
   const mutation=createSessionRevertMutationAuthority({withAuthority,admission:x.admission,stopAndDrain:async root=>{assert.equal(lifecycleHeld,false);stops++;await stop(root);}});
   await x.registry.getAdapter(b).request({type:'prompt',id:'background-b',message:'fixture streaming'});await x.until(()=>x.registry.snapshot().items.find(i=>i.conversationId===b.conversationId).activity==='running');
   const lease=await mutation({},body,authority=>{assert.equal(lifecycleHeld,true);return authority.lease;});
   assert.equal(stops,1);assert.equal((await x.registry.read(a,{type:'get_state'})).isStreaming,false);assert.equal((await x.registry.read(b,{type:'get_state'})).isStreaming,true);
   assert.throws(()=>x.admission.enterWriter(x.a.path),{code:'workspace_revert_busy'});lease.release();await x.registry.command(b,{type:'abort'});
  });
  await check('Bound resources reject all nine stale owner fields and retain at most 32 per live owner',async()=>{
   for(const key of Object.keys(a))assert.throws(()=>x.registry.bindResource({...a,[key]:'stale'},{dispose:async()=>{}}),{code:'stale_runtime'});
   const bindings=[];for(let i=0;i<32;i++)bindings.push(x.registry.bindResource(a,{dispose:async()=>{}}));
   assert.throws(()=>x.registry.bindResource(a,{dispose:async()=>{}}),{code:'runtime_resource_limit'});
   await Promise.all(bindings.map(r=>r.dispose()));
  });
  await check('Focus A to B to A increments trusted revision and disposes prior resources without changing A runtime',async()=>{
   await x.registry.focus(a);const revision=x.registry.contextRevision();let disposed=0;
   x.registry.bindResource(a,{dispose:async()=>{disposed++;}});await x.registry.focus(b);await x.registry.focus(a);
   assert.equal(disposed,1);assert.ok(x.registry.contextRevision()>revision);assert.deepEqual(x.registry.getOwner(a.conversationId),a);
   const current=x.registry.contextRevision();await x.registry.blur(a);assert.ok(x.registry.contextRevision()>current);
  });
  await check('Focus revision and resource invalidation precede async disposal; worktree authority remains available',async()=>{
   await x.registry.focus(a);let release,entered=false;const gate=new Promise(r=>release=r),revision=x.registry.contextRevision();
   const binding=x.registry.bindResource(a,{dispose:async()=>{await x.worktrees.withWorkspace({id:x.a.id,epoch:x.a.epoch},()=>{entered=true;});await gate;}});
   const focusing=x.registry.focus(b);await x.until(()=>entered);assert.equal(binding.isCurrent(),false);assert.ok(x.registry.contextRevision()>revision);
   release();await focusing;assert.equal(x.registry.snapshot().focusedConversationId,b.conversationId);
  });
  await check('Controlled bridgeRun change immediately revokes resource without changing the other actual fakePi session',async()=>{
   const owner={...a};
   let release,entered=false;const gate=new Promise(r=>release=r),binding=x.registry.bindResource(owner,{dispose:async()=>{entered=true;await gate;}});
   const child=x.children.find(c=>c.context.owner.runtimeId===owner.runtimeId);child.emit({type:'bridge_status',state:'ready',bridgeRun:2});
   assert.equal(binding.isCurrent(),false);assert.notEqual(x.registry.getOwner(owner.conversationId).runtimeGeneration,owner.runtimeGeneration);await x.until(()=>entered);
   assert.equal(x.registry.inUse(x.a.path),true);release();await binding.dispose();
   assert.deepEqual(x.registry.getOwner(b.conversationId),b);assert.equal((await x.registry.read(b,{type:'get_state'})).sessionId,b.sessionId);
   Object.assign(a,x.registry.getOwner(owner.conversationId));
  });
  await check('Retire invalidates owner before resource disposal and keeps admission until native task settles',async()=>{
   let release,entered=false;const gate=new Promise(r=>release=r);x.registry.bindResource(a,{dispose:async()=>{entered=true;await gate;}});
   const closing=x.registry.close(a);await x.until(()=>entered);
   assert.throws(()=>x.registry.getAdapter(a),{code:'stale_runtime'});assert.equal(x.registry.inUse(x.a.path),true);assert.equal(x.registry.liveCount(),2);
   release();await closing;assert.equal(x.registry.inUse(x.a.path),false);assert.equal(x.registry.liveCount(),1);
   assert.equal((await x.registry.read(b,{type:'get_state'})).sessionId,b.sessionId);
  });
  await check('Git indexes, refs and main HEAD are unchanged by lifecycle recovery',()=>assert.deepEqual(x.baseline(),before));
  await check('Close/resume and explicit restart prove new owner against actual TEMP session header',async()=>{
   const resumed=await x.registry.resume(a.conversationId);await x.until(()=>x.registry.getOwner(a.conversationId)?.sessionId);
   let current=x.registry.getOwner(a.conversationId);assert.notEqual(current.runtimeId,a.runtimeId);assert.equal(current.sessionId,a.sessionId);
   const binding=x.registry.bindResource(current,{dispose:async()=>{}}),old=current;await x.registry.restart(current);await x.until(()=>x.registry.getOwner(a.conversationId)?.sessionId);
   current=x.registry.getOwner(a.conversationId);assert.equal(binding.isCurrent(),false);assert.notEqual(current.runtimeId,old.runtimeId);
   assert.equal(x.registry.historyTarget(a.conversationId).sessionId,a.sessionId);assert.ok(x.registry.historyTarget(a.conversationId).sessionLocator);
  });
  await check('Registry process restart rediscovers dormant history without spawning or trusting old backend owner',async()=>{
   const old=x.registry.getOwner(a.conversationId),count=x.children.length,binding=x.registry.bindResource(old,{dispose:async()=>{}});
   await x.reopenRegistry();assert.equal(x.children.length,count);assert.equal(x.registry.liveCount(),0);assert.equal(binding.isCurrent(),false);
   assert.notEqual(x.registry.snapshot().backendInstance,old.backendInstance);assert.equal(x.registry.historyTarget(a.conversationId).sessionId,a.sessionId);
   const resumed=await x.registry.resume(a.conversationId);await x.until(()=>x.registry.getOwner(resumed.conversationId)?.sessionId);
   assert.notEqual(x.registry.getOwner(resumed.conversationId).backendInstance,old.backendInstance);assert.deepEqual(x.baseline(),before);
  });
 });
 if(process.platform==='win32')await fixture(async x=>{
  const classic=await x.classicSession(),owner=classic.owner(),before=x.baseline(),object=await x.objectService(owner,{classic});
  await check('Classic actual RPC and Changes authority restores TEMP main project without changing Git',async()=>{
   const p=await object.service.prepareObjectRevert({},object.body),result=await object.service.applyObjectRevert({},object.confirmation(p));assert.equal(result.completion,'applied_verified');assert.equal(object.commits,1);assert.equal(fs.readFileSync(object.target,'utf8'),'base\nanchor\nuser-new\n');assert.deepEqual(x.baseline(),before);
   await classic.close();const replacement=await x.classicSession();assert.equal(replacement.owner().sessionId,owner.sessionId);assert.notEqual(replacement.owner().runtimeId,owner.runtimeId);await assert.rejects(object.service.applyObjectRevert({},object.confirmation(p)),{code:'stale_runtime'});assert.equal(object.binding.isCurrent(),false);
  });
 });
 if(process.platform==='win32')await fixture(async x=>{
  const owner=await x.start(x.a),object=await x.objectService(owner),p=await object.service.prepareObjectRevert({},object.body),bytes=fs.readFileSync(object.target);
  await check('Same-byte replacement of an actual worktree file refuses old Plan before Native Ready',async()=>{fs.renameSync(object.target,object.target+'.old');fs.writeFileSync(object.target,bytes);const r=await object.service.applyObjectRevert({},object.confirmation(p));assert.equal(r.completion,'not_applied');assert.equal(object.opens,0);assert.ok(fs.readFileSync(object.target).equals(bytes));});
  await check('Closed Runtime plus moved/recreated worktree cannot replay an old Plan',async()=>{await x.registry.close(owner);fs.renameSync(x.a.path,x.a.path+'-moved');fs.mkdirSync(x.a.path);fs.writeFileSync(object.target,bytes);await assert.rejects(object.service.applyObjectRevert({},object.confirmation(p)));assert.equal(object.commits,0);assert.ok(fs.readFileSync(object.target).equals(bytes));});
 });
 if(process.platform==='win32')await fixture(async x=>{
  const owner=await x.start(x.a),other=await x.start(x.b),before=x.baseline(),object=await x.objectService(owner);
  await check('Actual D3 core and unchanged D2 Native restore C to R under real Registry/Worktrees authority',async()=>{
   const prepared=await object.service.prepareObjectRevert({},object.body);assert.equal(prepared.backupReady,true);assert.equal((await object.get(prepared.planId)).runtimeContext,x.registry.contextRevision());
   const result=await object.service.applyObjectRevert({},object.confirmation(prepared));assert.equal(result.completion,'applied_verified');assert.equal(object.opens,1);assert.equal(object.commits,1);
   assert.equal(fs.readFileSync(object.target,'utf8'),'base\nanchor\nuser-new\n');const plan=await object.get(prepared.planId);assert.equal((await object.read(plan.files[0].currentRef)).toString(),object.current.toString());
   assert.equal((await x.registry.read(other,{type:'get_state'})).sessionId,other.sessionId);assert.deepEqual(x.baseline(),before);
  });
  await check('Same relative path on the second actual worktree restores independently and cannot borrow first-owner material',async()=>{
   const firstBytes=fs.readFileSync(object.target);
   const second=await x.objectService(other,{before:Buffer.from('second-base\nanchor\nuser\n'),after:Buffer.from('second-agent\nanchor\nuser\n'),current:Buffer.from('second-agent\nanchor\nuser-new\n')});
   const prepared=await second.service.prepareObjectRevert({},second.body),plan=await second.get(prepared.planId);assert.notEqual(second.body.fileId,object.body.fileId);
   const result=await second.service.applyObjectRevert({},second.confirmation(prepared));assert.equal(result.completion,'applied_verified');assert.equal(fs.readFileSync(second.target,'utf8'),'second-base\nanchor\nuser-new\n');assert.ok(fs.readFileSync(object.target).equals(firstBytes));
   await assert.rejects(object.read(plan.files[0].currentRef));assert.deepEqual(x.baseline(),before);
  });
 });
 if(process.platform==='win32')await fixture(async x=>{
  const owner=await x.start(x.a),other=await x.start(x.b);let focusing;
  const object=await x.objectService(owner,{stopHook:async()=>{focusing=x.registry.focus(other);let timer;try{await Promise.race([focusing,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('focus_deadlock')),800);})]);}finally{clearTimeout(timer);}await x.registry.focus(owner);}});
  await check('Prepare with simultaneous focus revocation settles without lifecycle/disposal deadlock or returning token',async()=>{
   await assert.rejects(object.service.prepareObjectRevert({},object.body),{code:'stale_runtime'});await focusing;assert.equal(object.binding.isCurrent(),false);assert.equal(object.opens,0);x.admission.assertAllowed(x.a.path);
  });
 });
 if(process.platform==='win32')await fixture(async x=>{
  const owner=await x.start(x.a),other=await x.start(x.b);let reached,release;const ready=new Promise(r=>reached=r),gate=new Promise(r=>release=r);
  const object=await x.objectService(owner,{openAttempt:async(args,native)=>{const attempt=await native(args);reached();await gate;return attempt;}}),prepared=await object.service.prepareObjectRevert({},object.body);
  await check('Close during actual Native Ready revokes owner while admission remains pinned until helper closes',async()=>{
   const applying=object.service.applyObjectRevert({},object.confirmation(prepared));await ready;
   await x.registry.command(other,{type:'prompt',id:'b-during-native-ready',message:'unrelated workspace fixture'});await x.until(()=>x.registry.snapshot().items.find(item=>item.conversationId===other.conversationId).activity==='running');assert.equal((await x.registry.read(other,{type:'get_state'})).isStreaming,true);
   const closing=x.registry.close(owner);
   assert.equal(object.binding.isCurrent(),false);assert.equal(x.registry.inUse(x.a.path),true);assert.throws(()=>x.admission.enterWriter(x.a.path),{code:'workspace_revert_busy'});
   release();const result=await applying;await closing;assert.equal(result.completion,'not_applied');assert.equal(object.commits,0);assert.ok(fs.readFileSync(object.target).equals(object.current));x.admission.assertAllowed(x.a.path);
  });
 });
 if(process.platform==='win32')await fixture(async x=>{
  const owner=await x.start(x.a),before=x.baseline(),object=await x.objectService(owner,{openAttempt:async(args,native)=>{const attempt=await native(args);return {...attempt,commit:async binding=>{await attempt.commit(binding);return {status:'protocol_unknown'};}};}});
  const prepared=await object.service.prepareObjectRevert({},object.body);
  await check('Actual Native write with damaged result retains recovery_required and C/R after Runtime close',async()=>{
   const result=await object.service.applyObjectRevert({},object.confirmation(prepared));assert.equal(result.completion,'recovery_required');assert.equal(result.durable,true);assert.equal(object.commits,1);
   assert.equal(fs.readFileSync(object.target,'utf8'),'base\nanchor\nuser-new\n');const plan=await object.get(prepared.planId);assert.equal(plan.state,'recovery_required');assert.ok((await object.read(plan.files[0].currentRef)).equals(object.current));
   await x.retain(object.scope,prepared.planId);await x.registry.close(owner);assert.equal(object.binding.isCurrent(),false);assert.deepEqual(x.baseline(),before);
  });
  await check('New backend may read validated historical C/R without inheriting old mutation owner or changing journal',async()=>{
   await x.reopenRegistry();const {createSessionRevertObjectHistoryAuthority}=await import('../server/session-revert-object-runtime-authority.js'),{createSessionRevertObjectRecoveryReader}=await import('../server/session-revert-object-recovery-reader.js');
   const history=createSessionRevertObjectHistoryAuthority({registry:x.registry,worktrees:x.worktrees,withReadAuthority:async(_req,body,fn)=>fn({conversationId:body.conversationId,revalidate:async()=>{}})});
   const journal=path.join(x.data,'revert-evidence/v1/journal.jsonl'),bytes=fs.readFileSync(journal),stat=fs.statSync(journal);
   await history({},{conversationId:owner.conversationId},async authority=>{const reader=createSessionRevertObjectRecoveryReader({dataDir:x.data,authorizeHistorical:authority.authorizeHistorical});const inspected=await reader.inspectHistorical({planId:prepared.planId});assert.equal(inspected.readOnly,true);assert.equal(inspected.applyEligible,false);const material=await reader.readHistorical({planId:prepared.planId,material:'current'});assert.ok(material.materials.current.equals(object.current));});
   assert.ok(fs.readFileSync(journal).equals(bytes));assert.equal(fs.statSync(journal).mtimeMs,stat.mtimeMs);assert.equal(x.registry.liveCount(),0);
   const resumed=await x.registry.resume(owner.conversationId);await x.until(()=>x.registry.getOwner(resumed.conversationId)?.sessionId);assert.notEqual(x.registry.getOwner(resumed.conversationId).backendInstance,owner.backendInstance);
   await assert.rejects(object.service.applyObjectRevert({},object.confirmation(prepared)),{code:'stale_runtime'});assert.deepEqual(x.baseline(),before);
  });
 });
 let rejectFocus=false;
 await fixture(async x=>{
  const a=await x.start(x.a),b=await x.start(x.b);await x.registry.focus(a);let disposed=0;
  const binding=x.registry.bindResource(a,{dispose:async()=>{disposed++;}});rejectFocus=true;
  await check('Failed focus callback still disposes invalidated resources without leaking reservations',async()=>{
   await assert.rejects(x.registry.focus(b),{code:'focus_rejected'});assert.equal(binding.isCurrent(),false);assert.equal(disposed,1);assert.equal(x.registry.snapshot().focusedConversationId,a.conversationId);
  });
 },{onFocus:async()=>{if(rejectFocus)throw Object.assign(Error('focus_rejected'),{code:'focus_rejected'});}});
 await fixture(async x=>{
  const owner=await x.start(x.a);let rejectCleanup=true,calls=0;
  const binding=x.registry.bindResource(owner,{dispose:async()=>{calls++;if(rejectCleanup)throw Error('secret diagnostic payload');}});
  await check('Disposal failure retains slot/lease, invalidates capability and exposes only cleanup_pending',async()=>{
   await assert.rejects(x.registry.close(owner),{code:'cleanup_pending',message:'cleanup_pending'});
   assert.equal(binding.isCurrent(),false);assert.equal(x.registry.inUse(x.a.path),true);assert.equal(x.registry.liveCount(),1);
   assert.equal(x.registry.snapshot().items[0].error,'cleanup_pending');assert.ok(!JSON.stringify(x.events).includes('secret diagnostic payload'));
   await assert.rejects(x.registry.start({id:x.a.id,epoch:x.a.epoch}),{code:'workspace_in_use'});
  });
  await check('Explicit cleanup retry releases retained resource only after successful disposal',async()=>{
   rejectCleanup=false;await x.registry.close(x.registry.getOwner(owner.conversationId));assert.equal(calls,2);assert.equal(x.registry.liveCount(),0);assert.equal(x.registry.inUse(x.a.path),false);
  });
 });
 console.log(`Session revert object runtime: ${checks}/${checks}; layer=real Registry/Worktrees + fakePi guardian; real-model=unverified`);
})().catch(e=>{console.error(e);process.exitCode=1;});
