const assert=require('node:assert/strict');
(async()=>{
 const {projectObjectPlan,projectObjectResult,projectObjectHistory,createSessionRevertObjectQualification,createSessionRevertObjectHistory}=await import('../server/session-revert-object-presentation.js');
 let checks=0;const check=(name,fn)=>{fn();checks++;console.log('ok '+name);};
 const owner={conversationId:'chat',workspaceId:'workspace',workspaceEpoch:'epoch',runtimeGeneration:'generation'};
 const raw={ok:true,planId:'plan',providerId:'windows-original-object-v1',riskNoticeVersion:3,kind:'revert',expiresAt:100,revision:2,backupReady:true,currentBytes:12,candidateBytes:8,
  scope:{...owner,workspaceFingerprint:'a'.repeat(64)},files:[{fileId:'b'.repeat(64),objectId:'volume:file',relativePath:'file.txt',diff:'--- current\n+++ candidate\n',security:{sddl:'PRIVATE'}}],confirmationToken:'PRIVATE',helperHash:'PRIVATE',proofId:'PRIVATE'};
 check('safe plan fields do not disclose private authority',()=>{const p=projectObjectPlan(raw);assert.equal(p.fileId,raw.files[0].fileId);assert.equal(p.objectId,'volume:file');assert.equal(p.diff,raw.files[0].diff);assert.ok(!JSON.stringify(p).includes('PRIVATE'));});
 check('raw metadata and root cannot enter projection',()=>{const p=projectObjectPlan({...raw,root:'PRIVATE',scope:{...raw.scope,root:'PRIVATE',runtimeOwner:{...owner,private:'PRIVATE'}}});assert.ok(!JSON.stringify(p).includes('PRIVATE'));});
 check('old risk plan has no UI execution projection',()=>assert.throws(()=>projectObjectPlan({...raw,riskNoticeVersion:2})));
 check('oversized diff fails closed',()=>assert.throws(()=>projectObjectPlan({...raw,files:[{...raw.files[0],diff:'x'.repeat(32769)}]})));
 check('multiple files cannot enter single-file UI',()=>assert.throws(()=>projectObjectPlan({...raw,files:[raw.files[0],raw.files[0]]})));
 check('verified result is narrowly projected',()=>{const p=projectObjectResult({ok:true,planId:'plan',completion:'applied_verified',durable:true,backupReady:true,objectMaintained:true,confirmationToken:'PRIVATE'});assert.equal(p.objectMaintained,true);assert.equal(p.retryAllowed,false);assert.ok(!JSON.stringify(p).includes('PRIVATE'));});
 check('undurable verified is not shown as success',()=>{const p=projectObjectResult({ok:true,planId:'plan',completion:'applied_verified',durable:false});assert.equal(p.ok,false);assert.equal(p.completion,'recovery_required');});
 for(const durable of [undefined,null])check('unknown durability cannot be verified success '+String(durable),()=>{const p=projectObjectResult({ok:true,completion:'applied_verified',durable,objectMaintained:true});assert.equal(p.ok,false);assert.equal(p.objectMaintained,false);assert.equal(p.completion,'recovery_required');});
 check('unknown completion cannot become success',()=>assert.throws(()=>projectObjectResult({ok:true,completion:'PRIVATE'})));
 check('legacy history remains display only without private material',()=>{const p=projectObjectHistory({...raw,riskNoticeVersion:2,completion:'recovery_required'});assert.equal(p.readOnly,true);assert.equal(p.recoveryEligible,false);assert.equal(p.backupReady,false);assert.equal(p.riskNoticeVersion,2);assert.ok(!JSON.stringify(p).includes('PRIVATE'));});
 let revalidated=0;const scope={workspaceId:'workspace',workspaceEpoch:'epoch',conversationId:'chat',nativeSessionId:'native',workspaceFingerprint:'a'.repeat(64),runtimeOwner:{backendInstance:'backend',projectId:'project',repoId:null,...owner,runtimeId:'runtime',sessionId:'native'}};
 const store={queryEvidence:async()=>({revision:5,gapRevision:0,files:[{relativePath:'file.txt',evidenceIds:['operation'],evidenceLevel:'intent_verified'}]}),previewRevision:async()=>({revision:5,gapRevision:0})};
 const qualify=createSessionRevertObjectQualification({store,withAuthority:async(req,body,fn)=>fn({scope,revalidate:async()=>revalidated++})});
 const body={conversationId:'chat',evidenceIds:['operation'],evidenceRevision:5};
 const result=await qualify({},body);
 check('production qualification is definitively disabled',()=>{assert.equal(result.eligible,false);assert.equal(result.applyEligible,false);assert.equal(result.reason,'production_allowlist_empty');assert.equal(result.riskNoticeVersion,3);assert.equal(revalidated,1);assert.ok(result.fileId);});
 for(const key of ['root','path','candidateBytes','supported','riskNoticeVersion','confirmationToken']){await assert.rejects(()=>qualify({},{...body,[key]:'PRIVATE'}),e=>e.code==='invalid_request');checks++;console.log('ok client '+key+' rejected');}
 await assert.rejects(()=>qualify({},{...body,evidenceRevision:4}),e=>e.code==='stale_evidence');checks++;
 await assert.rejects(()=>qualify({},{...body,evidenceIds:['foreign']}),e=>e.code==='evidence_not_found');checks++;
 const history=createSessionRevertObjectHistory({store:{...store,applyList:async()=>[{...raw,scope,completion:'recovery_required',createdAt:1}, {...raw,scope:{...scope,conversationId:'foreign'},completion:'recovery_required',createdAt:1}]},withAuthority:async(req,body,fn)=>fn({scope,revalidate:async()=>{}})});
 const records=await history({},{conversationId:'chat'});check('history filters unrelated scope and never qualifies old plans',()=>{assert.equal(records.plans.length,1);assert.equal(records.plans[0].applyEligible,false);assert.equal(records.plans[0].recoveryEligible,false);});
 const {createSessionRevertRoutes}=await import('../server/session-revert-routes.js');
 const http=require('node:http');const handler=createSessionRevertRoutes({store,withAuthority:async(req,body,fn)=>fn({scope,revalidate:async()=>{}})});
 const server=http.createServer((req,res)=>void handler.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const url='http://127.0.0.1:'+server.address().port+'/api/session-revert/object-qualification';
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(response.status,200);assert.equal((await response.json()).applyEligible,false);checks++;
  for(const extra of [{supported:true},{root:'PRIVATE'},{owner:{unknown:'PRIVATE'}}]){
   const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,...extra})});assert.equal(r.status,400);assert.equal((await r.json()).code,'invalid_request');checks++;
  }
 }finally{await new Promise(r=>server.close(r));}
 console.log(`Object presentation: ${checks}/${checks}; read-only projection and DI authority`);
})().catch(e=>{console.error(e);process.exitCode=1;});
