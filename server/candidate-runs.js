/* Orchestrates existing lifecycle/RPC capabilities; never executes shell commands. */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureCandidateInput,installCandidateInput,compareCandidateInput,candidateHash,candidatePath,candidateFail,assertCandidateTarget} from '../lib/candidate-snapshot.js';
import {createCandidateStore} from './candidate-store.js';
import {createCandidateApply} from './candidate-apply.js';
import {observeAdoptionSnapshot,createAdoptionEvidence,checkCandidateAdoption} from '../lib/candidate-adoption.js';
import {gitDiff} from '../lib/git.js';
import {diffHtml,createReviewTask,reconcileReviewRange} from '../lib/candidate-review-model.js';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const identity=p=>{const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())candidateFail('candidate_unsafe');return[s.dev,s.ino,s.birthtimeMs];};
const encode=s=>s&&({...s,files:s.files.map(f=>({...f,bytes:f.bytes.toString('base64')}))});
const terminal=new Set(['completed','failed','stopped','interrupted']);
const uncertain=(live,reason)=>{live.uncertain=true;(live.problems ||= new Set()).add(reason);};
// Git status can rewrite index stat caches without changing staged entries.
// ContentId includes the complete logical index; file identities remain separate.
const sameObservation=(a,b)=>Boolean(a&&b&&a.contentId===b.contentId&&a.configDigest===b.configDigest&&equal(a.identity,b.identity)&&equal(a.files.map(f=>f.identity),b.files.map(f=>f.identity)));
const warning='Worktree 只隔离 Git 工作目录，不是操作系统沙箱。同用户 Agent 仍可能访问原项目或其他路径；现有工具审批继续生效。候选结果不会应用到原工作区。';
const candidatePrompt=plan=>`候选执行确认：只在当前候选工作目录处理下面的引用任务。原项目路径只是来源数据，不是写入授权。优先使用原生 write/edit；未知工具或无法核实的副作用将使结果标为待确认。不得操作原工作区或应用候选结果。\n输入快照：${plan.input.contentId}\n\n${plan.selected.value.text}`;

function rows(text){
  // Reuse the exact renderer's validated row hashes, coordinates and hunk completeness.
  const html=diffHtml(text,{commentable:true}),result=[];
  for(const h of html.matchAll(/<span class="d-hunkwrap"[^>]*data-range-complete="(0|1)"[^>]*>([\s\S]*?)(?=<span class="d-hunkwrap"|<\/pre>)/g)){
    for(const r of h[2].matchAll(/class="d-row" data-line-type="([a-z]+)" data-old-line="(\d*)" data-new-line="(\d*)" data-hunk-index="(\d+)" data-hunk-header="([a-f0-9]+)" data-code-hash="([a-f0-9]+)"/g))
      result.push({type:r[1],oldLine:r[2]?Number(r[2]):null,newLine:r[3]?Number(r[3]):null,hunkIndex:Number(r[4]),hunkHeader:r[5],codeHash:r[6],rangeComplete:h[1]==='1'});
  }
  return result;
}
export function createCandidateRuns({dataDir,worktrees,registry,readComments,projectFor,contextGeneration,busy=()=>false,admission,protectedRoots=()=>[],now=Date.now}={}){
  const store=createCandidateStore({dataDir,protectedRoots}),plans=new Map(),records=new Map();let active=null,checkingAdoption=false,disposed=false,storageError=null;
  const adoption=createCandidateApply({dataDir,worktrees,admission,protectedRoots,now,assertIdle:()=>{if(disposed||storageError)candidateFail(storageError||'candidate_unavailable');store.assertIdle();if(active||busy(true))candidateFail('candidate_busy');}});
  try{for(const saved of store.readAll()){
    if(!terminal.has(saved.run.state)){saved.run.state='interrupted';saved.result=null;saved.run.reason='candidate_interrupted';}
    records.set(saved.run.id,saved);
  }}catch{storageError='candidate_storage_unsafe';}
  function check(scope){if(disposed)candidateFail('candidate_unavailable');if(storageError)candidateFail(storageError);scope.assertCurrent();}
  function idle(){if(active||checkingAdoption||adoption.busy()||busy())candidateFail('candidate_busy');}
  function own(owner){return active&&active.owner?.conversationId===owner?.conversationId&&active.owner?.workspaceId===owner?.workspaceId?active:null;}
  function persist(live){const value={version:1,run:live.run,input:encode(live.pre),result:live.result||null,adoptionEvidence:live.adoptionEvidence||null};store.save(value);records.set(live.run.id,{...value,run:structuredClone(live.run)});}
  async function task(scope,body,owner){
    check(scope);const data=readComments(scope);
    if(body.scope!==scope.key||data.revision!==body.revision||!Array.isArray(body.selectedIds)||!body.selectedIds.length||new Set(body.selectedIds).size!==body.selectedIds.length)candidateFail('candidate_comments_changed');
    const comments=[];
    for(const id of body.selectedIds){const c=data.comments.find(c=>c.id===id);if(!c)candidateFail('candidate_comments_changed');candidatePath(c.path);
      const diff=await gitDiff(scope.projectRoot,c.path,{context:'all'});check(scope);
      if(!diff.ok||diff.binary||diff.truncated)candidateFail('candidate_anchor_changed');
      const lines=rows(diff[c.anchor.section]||'');
      const valid=c.anchor.range?reconcileReviewRange(c.anchor,lines,'')==='valid':lines.filter(r=>['type','oldLine','newLine','codeHash'].every(k=>r[k]===c.anchor[k])).length===1;
      if(!valid)candidateFail('candidate_anchor_changed');comments.push({...c,scope:scope.key,verified:true,stale:false});
    }
    const value=createReviewTask({comments,selectedIds:body.selectedIds,context:{scope:scope.key,project:scope.projectRoot,worktree:scope.projectRoot,session:owner?.sessionId||'current',storage:{status:'ready',revision:data.revision}}});
    if(!value.ok)candidateFail('candidate_limit');
    return{value,revision:data.revision,commentDigest:candidateHash(JSON.stringify(comments)),paths:[...new Set(comments.map(c=>c.path))]};
  }
  async function prepare(scope,body,owner){
    check(scope);idle();if(scope.workspaceCwd&&scope.workspaceCwd!==scope.projectRoot)candidateFail('candidate_unsupported');const input=await captureCandidateInput(scope.projectRoot);check(scope);
    const selected=await task(scope,body,owner);idle();
    const generation=contextGeneration(),project=projectFor(scope.projectRoot),runtimeCount=registry.snapshot().totalCount||0;
    if(runtimeCount>=3)candidateFail('candidate_busy');
    const prepared=await worktrees.prepareCandidate({project,source:input.head,branch:`pi-gui/t4b/${randomUUID()}`},generation);check(scope);idle();
    if(plans.size>=8)plans.delete(plans.keys().next().value);
    let sourceObservation=null;try{sourceObservation=observeAdoptionSnapshot(input);}catch{/* Optional C1 evidence must not change T4-B execution eligibility. */}
    const nonce=randomUUID();plans.set(nonce,{scope,body,owner,input,sourceObservation,selected,prepared,generation,allowThird:runtimeCount>=2,expires:now()+300000});
    return{ok:true,nonce,plan:{head:input.head,inputId:input.contentId,counts:input.counts,source:scope.projectRoot,conversationId:owner?.conversationId||'classic-chat',commentCount:body.selectedIds.length,files:selected.paths,inputFiles:input.files.length,inputBytes:input.bytes,path:prepared.plan.path,warning,task:candidatePrompt({input,selected}),runtimeCount}};
  }
  async function validate(plan,scope){
    check(scope);if(scope.key!==plan.scope.key||scope.token!==plan.scope.token||plan.expires<now()||plan.generation!==contextGeneration())candidateFail('candidate_expired');
    check(plan.scope); // Persistent scope equality must not revive a retired owner.
    const snapshot=await captureCandidateInput(scope.projectRoot);check(scope);
    if(snapshot.id!==plan.input.id)candidateFail('candidate_changed');
    const selected=await task(scope,plan.body,plan.owner);if(selected.commentDigest!==plan.selected.commentDigest)candidateFail('candidate_comments_changed');
  }
  async function confirm(scope,nonce){
    const plan=plans.get(nonce);plans.delete(nonce);if(!plan)candidateFail('candidate_expired');idle();
    await validate(plan,scope);idle();store.acquire();
    const live={run:{id:randomUUID(),sourceScope:scope.key,sourceConversation:plan.owner?.conversationId||'classic-chat',state:'pending',createdAt:now(),inputId:plan.input.contentId,warning},source:plan.input,sourceObservation:plan.sourceObservation,pre:plan.input,result:null,owner:null,queue:Promise.resolve(),calls:new Map(),uncertain:false,sending:false,started:false};
    active=live;
    try{
      persist(live);
      const created=await worktrees.createCandidate({nonce:plan.prepared.nonce},plan.generation,()=>validate(plan,scope));
      live.run.workspace={id:created.workspace.id,epoch:created.workspace.epoch,repoId:created.workspace.repoId,branch:created.workspace.branch,path:created.workspace.path};
      live.root=created.workspace.path;
      live.pre=await worktrees.withWorkspace({id:live.run.workspace.id,epoch:live.run.workspace.epoch},()=>installCandidateInput(plan.input,live.root));
      check(scope);await validate(plan,scope);persist(live);
      // Start only this execution once. Closing the UI never cancels this promise.
      void execute(live,plan,scope).catch(()=>finish(live,'failed','candidate_start_failed'));
      return{ok:true,run:summary(live.run)};
    }catch(e){live.run.state='failed';live.run.reason=e.code||'candidate_failed';try{persist(live);store.release();}finally{active=null;}throw e;}
  }
  async function execute(live,plan,scope){
    const opened=await registry.start({id:live.run.workspace.id,epoch:live.run.workspace.epoch,allowThird:plan.allowThird});live.owner=opened.owner;live.run.conversationId=opened.conversationId;persist(live);
    for(let i=0;i<100;i++){
      if(active!==live||disposed)candidateFail('candidate_interrupted');check(scope);
      const owner=registry.getOwner(opened.conversationId),item=registry.snapshot().items.find(i=>i.conversationId===opened.conversationId);
      if(item?.lifecycle==='error')candidateFail('candidate_start_failed');
      if(owner?.sessionId&&item?.lifecycle==='ready'){live.owner=owner;break;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!live.owner?.sessionId)candidateFail('candidate_start_failed');
    await registry.getAdapter(live.owner).toolGuard.assertReady();
    await validate(plan,scope);const before=await captureCandidateInput(live.root,{includeNew:true});
    if(before.contentId!==live.pre.contentId)candidateFail('candidate_changed');
    try{live.inputObservation=observeAdoptionSnapshot(before);}catch{/* Optional C1 evidence; never infer missing object identities after execution. */}
    live.pre=before;live.latest=before;live.run.rootIdentity=identity(live.root);live.run.gitIdentity=candidateHash(fs.readFileSync(path.join(live.root,'.git')));
    live.run.state='running';live.started=true;persist(live);check(scope);
    const instruction=candidatePrompt(plan);
    live.sending=true;await registry.command(live.owner,{type:'prompt',id:live.run.id,message:instruction});live.sending=false;
  }
  function queue(live,fn){const next=live.queue.catch(()=>{}).then(fn);live.queue=next.catch(()=>{uncertain(live,'audit_unavailable');});return next;}
  async function audit(owner,event){
    const live=own(owner);if(!live||!live.started)return;
    return queue(live,async()=>{
      const current=await worktrees.withWorkspace(live.run.workspace,()=>captureCandidateInput(live.root,{includeNew:true}));
      if(event.phase==='begin'){
        if(!sameObservation(current,live.latest)||live.calls.size){
          uncertain(live,'unbracketed_change');
          for(const key of ['contentId','identity','indexDigest','configDigest','counts','untracked'])if(!equal(current[key],live.latest[key]))uncertain(live,'changed_'+key);
          if(!equal(current.files.map(f=>f.identity),live.latest.files.map(f=>f.identity)))uncertain(live,'changed_file_identity');
        }
        const a=event.audit;
        if(!a||!['read','write','edit'].includes(a.kind))uncertain(live,'unknown_tool');
        if(a?.path)assertCandidateTarget(live.root,a.path);
        live.calls.set(event.callId,{audit:a,before:current});
      }else{
        const call=live.calls.get(event.callId);live.calls.delete(event.callId);
        if(!call)uncertain(live,'missing_tool_begin');
        else{
          const b=new Map(call.before.files.map(f=>[f.path,f])),a=new Map(current.files.map(f=>[f.path,f]));
          const changed=[...new Set([...b.keys(),...a.keys()])].filter(p=>b.get(p)?.digest!==a.get(p)?.digest||b.get(p)?.mode!==a.get(p)?.mode);
          if([...b].some(([p,f])=>a.has(p)&&(!equal(f.identity,a.get(p).identity)||f.mode!==a.get(p).mode)))uncertain(live,'file_identity_or_mode_changed');
          if(call.audit?.kind==='read'&&changed.length)uncertain(live,'read_side_effect');
          if(changed.some(p=>p!==call.audit?.path)||changed.length&&!/^[a-f0-9]{64}$/.test(call.audit?.expectedHash||'')||changed.length&&a.get(call.audit?.path)?.digest!==call.audit.expectedHash)uncertain(live,'unconfirmed_tool_effect');
          if(!equal(current.staged,call.before.staged)||current.head!==call.before.head||current.counts.ignored!==call.before.counts.ignored)uncertain(live,'git_or_ignored_changed');
        }
      }
      live.latest=current;
    });
  }
  async function finish(live,state,reason){
    if(active!==live||live.finishing)return;live.finishing=true;
    await live.queue.catch(()=>{});
    try{
      // A settled frame does not exclude child cleanup writes. Retire and confirm
      // the existing execution line before taking the final disk observation.
      if(live.owner)await registry.close(live.owner);
      await live.queue.catch(()=>{});
      if(live.started){
        if(!equal(identity(live.source.root),live.source.identity[0])||(await captureCandidateInput(live.source.root)).id!==live.source.id)uncertain(live,'source_changed');
        const post=await worktrees.withWorkspace(live.run.workspace,()=>captureCandidateInput(live.root,{includeNew:true}));
        if(!sameObservation(post,live.latest)||live.calls.size)uncertain(live,'post_changed');
        live.result=await compareCandidateInput(live.pre,post);
        live.result.reliable=!live.uncertain&&state==='completed';
        live.result.unconfirmedReasons=[...(live.problems||[])];
        if(post.counts.ignored)live.result.reliable=false;
        live.result.notice=live.result.reliable?'已核对输入、受控工具目标及执行前后文件；不是操作系统级写者隔离证明。':'结果无法可靠确认：检测到未核实工具、外部变化、失败或证据缺口。';
        if(live.sourceObservation&&live.inputObservation)try{live.adoptionEvidence=createAdoptionEvidence({run:{...live.run,state:live.stopping?'stopped':state},source:live.sourceObservation,input:live.inputObservation,output:observeAdoptionSnapshot(post),result:live.result});}catch{/* Missing new evidence keeps T4-B history viewable, but cannot authorize adoption. */}
      }
      live.run.state=live.stopping?'stopped':state;live.run.reason=reason||null;live.run.endedAt=now();persist(live);
      store.release();active=null;
    }catch{live.run.state='interrupted';live.run.reason='candidate_result_unavailable';live.result=null;try{persist(live);}catch{}/* unknown cleanup retains the lock */active=null;}
  }
  async function observe(frame){
    const live=own(frame?.owner);if(!live||live.finishing)return;
    if(live.owner.runtimeGeneration&&frame.owner.runtimeGeneration!==live.owner.runtimeGeneration)return finish(live,'interrupted','candidate_runtime_changed');
    const event=frame.event||{};
    if(event.type==='stop_state'&&event.pending===true)live.stopping=true;
    if(event.type==='stop_state'&&event.pending===false&&live.stopping)return finish(live,'stopped');
    if(event.generationResult?.outcome==='failed')live.failed=true;
    if(frame.type==='runtime_closed'||frame.type==='runtime_state'&&frame.item?.lifecycle==='error')return finish(live,'interrupted','candidate_runtime_lost');
    if(event.type==='agent_settled'&&live.started){
      if(live.stopping)return; // settled is not the authoritative Stop acknowledgement
      try{const state=await registry.read(live.owner,{type:'get_state'});if(state?.sessionId!==live.owner.sessionId||state?.isStreaming===true)return finish(live,'interrupted','candidate_completion_unconfirmed');
        return finish(live,live.failed?'failed':'completed');}catch{return finish(live,'interrupted','candidate_completion_unconfirmed');}
    }
  }
  function summary(run){return{id:run.id,state:run.state,reason:run.reason||null,createdAt:run.createdAt,endedAt:run.endedAt,inputId:run.inputId,workspace:run.workspace,conversationId:run.conversationId,warning};}
  function get(scope,id){check(scope);const saved=active?.run.id===id?active:records.get(id);if(!saved)candidateFail('candidate_missing');
    const r=saved.run;
    if(r.sourceScope!==scope.key&&r.workspace?.path!==scope.projectRoot)candidateFail('candidate_scope');
    try{if(r.workspace&&!worktrees.projectFor(r.workspace.path))candidateFail('candidate_unsafe');if(r.rootIdentity&&(!equal(identity(r.workspace.path),r.rootIdentity)||candidateHash(fs.readFileSync(path.join(r.workspace.path,'.git')))!==r.gitIdentity))candidateFail('candidate_unsafe');}
    catch{return{ok:true,run:{...summary(r),state:'interrupted',reason:'candidate_identity_changed'},result:null};}
    return{ok:true,run:summary(r),result:terminal.has(r.state)?saved.result||null:null,adoption:adoption.status(scope,id)};
  }
  function list(scope){check(scope);return{ok:true,runs:[...records.values()].filter(v=>v.run.sourceScope===scope.key||v.run.workspace?.path===scope.projectRoot).map(v=>summary(v.run))};}
  async function checkAdoption(scope,id){
    check(scope);idle();store.assertIdle();if(get(scope,id).run.reason==='candidate_identity_changed')candidateFail('candidate_output_changed');
    const saved=records.get(id);if(!saved)candidateFail('candidate_missing');
    checkingAdoption=true;
    try{return await checkCandidateAdoption({saved,scope,worktrees,assertIdle:()=>{check(scope);store.assertIdle();if(active||busy())candidateFail('candidate_busy');}});}
    finally{checkingAdoption=false;}
  }
  async function prepareAdoption(scope,id){check(scope);idle();get(scope,id);const saved=records.get(id);if(!saved)candidateFail('candidate_missing');checkingAdoption=true;try{return await adoption.prepare(scope,saved);}finally{checkingAdoption=false;}}
  const confirmAdoption=(scope,nonce)=>{check(scope);idle();return adoption.confirm(scope,nonce);};
  const prepareRecovery=(scope,id)=>{check(scope);idle();return adoption.prepareRecovery(scope,id);};
  const confirmRecovery=(scope,nonce)=>{check(scope);idle();return adoption.confirmRecovery(scope,nonce);};
  function cancel(scope,nonce){check(scope);const plan=plans.get(nonce);if(plan&&plan.scope.key!==scope.key)candidateFail('candidate_scope');plans.delete(nonce);return{ok:true};}
  async function stop(scope,id){get(scope,id);const live=active;if(!live||live.run.id!==id||!live.owner)candidateFail('candidate_not_running');live.stopping=true;
    const result=await registry.command(live.owner,{type:'abort'});if(!result?.ok)candidateFail('candidate_stop_pending');await finish(live,'stopped');return get(scope,id);}
  return{prepare,confirm,cancel,get,list,stop,checkAdoption,prepareAdoption,confirmAdoption,prepareRecovery,confirmRecovery,cancelAdoption:adoption.cancel,audit,observe,busy:()=>Boolean(active||checkingAdoption||adoption.busy()),owns:owner=>Boolean(own(owner)),async dispose(){disposed=true;plans.clear();if(active?.owner){try{await registry.command(active.owner,{type:'abort'});await finish(active,'interrupted','candidate_shutdown');}catch{}}}};
}
