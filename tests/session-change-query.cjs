const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const {execFileSync}=require('node:child_process');
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log('  ok  ' + name); };
(async () => {
  const { createSessionChangeStore } = await import('../server/session-change-store.js');
  const { createSessionRevertRoutes } = await import('../server/session-revert-routes.js');
  const { createRouter } = await import('../server/router.js');
  const { createAuth } = await import('../server/auth.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p33-query-'));
  const git=(...args)=>execFileSync('git',['-C',root,...args],{windowsHide:true,stdio:'pipe'});
  git('init','--quiet');await fs.writeFile(path.join(root,'user.txt'),'existing user content\n');git('add','user.txt');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','fixture');
  const gitIndex=await fs.readFile(path.join(root,'.git/index')),gitRef=git('rev-parse','HEAD');
  const owner = { backendInstance:'backend',projectId:'project',repoId:null,workspaceId:'workspace',workspaceEpoch:'epoch',conversationId:'A',runtimeId:'runtime',runtimeGeneration:'generation',sessionId:'native' };
  const scope = { runtimeOwner:owner,conversationId:'A',nativeSessionId:'native',workspaceId:'workspace',workspaceEpoch:'epoch' };
  let time = Date.now(), busy = false, stale = false, blobReads = 0;
  const store = await createSessionChangeStore({ dataDir:root,privacyCheck:async()=>true,now:()=>time });
  const routes = createSessionRevertRoutes({store,withAuthority:async(_req,body,fn,options={})=>{
    if (JSON.stringify(body.owner)!==JSON.stringify(owner) || body.conversationId!=='A') throw Object.assign(Error('private root '+root),{code:'stale_runtime'});
    return fn({scope,root,activeWriter:busy,revalidate:async()=>{if(stale || busy && !options.allowActiveWriter)throw Object.assign(Error(root),{code:stale?'stale_runtime':'active_writer'});}});
  }});
  const server = http.createServer((req,res)=>createRouter({auth:createAuth({token:'query-token',port:server.address().port}),sessionRevert:routes})(req,res));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const call = async(extra={},endpoint='query')=>fetch('http://127.0.0.1:'+server.address().port+'/api/session-revert/'+endpoint,{method:'POST',headers:{'content-type':'application/json','x-pi-gui-token':'query-token'},body:JSON.stringify({conversationId:'A',owner,...extra})}).then(r=>r.json());
  try {
    await check('store offers bounded read-only evidence query',()=>assert.equal(typeof store.queryEvidence,'function'));
    await check('capture disabled is explicit empty state',async()=>{const r=await call();assert.equal(r.ok,true);assert.equal(r.capture.enabled,false);assert.equal(r.operationCount,0);assert.deepEqual(r.files,[]);});
    await check('query rejects missing authentication before store access',async()=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/session-revert/query',{method:'POST',body:'{}'});assert.equal(r.status,401);});
    await check('query rejects foreign Origin despite valid token',async()=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/session-revert/query',{method:'POST',headers:{origin:'https://foreign.invalid','x-pi-gui-token':'query-token'},body:'{}'});assert.equal(r.status,403);});
    await check('query is POST-only with bounded request body',async()=>{const base='http://127.0.0.1:'+server.address().port+'/api/session-revert/query';assert.equal((await fetch(base,{headers:{'x-pi-gui-token':'query-token'}})).status,405);assert.equal((await fetch(base,{method:'POST',headers:{'x-pi-gui-token':'query-token'},body:' '.repeat(17000)})).status,413);});
    await store.configure(scope,{enabled:true,acknowledged:true});
    for (let i=0;i<3;i++) {
      await store.prepare(scope,{operationId:'op'+i,toolCallId:'tool'+i,path:'file'+i+'.txt',before:i===0?null:Buffer.from('before\n'),intendedAfter:Buffer.from('after\n'),effectiveToolSource:'pi-gui-revert'});
      await store.settle(scope,'op'+i,{observedAfter:Buffer.from('after\n'),toolOutcome:'success',mutationOutcome:'written',evidenceLevel:'intent_verified'});
      await store.amendOutcome(scope,'op'+i,{toolOutcome:'success'});
    }
    const journal = path.join(root,'revert-evidence/v1/journal.jsonl'), before = await fs.readFile(journal);
    let first;
    await check('bounded first page has accurate aggregate and selection IDs',async()=>{first=await call({limit:1});assert.equal(first.ok,true);assert.equal(first.fileCount,3);assert.equal(first.operationCount,3);assert.equal(first.files.length,1);assert.equal(first.files[0].operationType,'created');assert.equal(first.files[0].previewEligible,true);assert.deepEqual(first.files[0].evidenceIds,['op0']);assert.deepEqual(first.owner,owner);assert.ok(first.nextCursor);});
    await check('next page does not repeat first file',async()=>{const r=await call({limit:1,cursor:first.nextCursor});assert.equal(r.files[0].relativePath,'file1.txt');});
    await check('summary contains no snapshots absolute path references or capabilities',async()=>{const s=JSON.stringify(await call());for(const v of ['before\n','after\n',root,'beforeRef','currentRef','digest','capability','toolCallId'])assert.ok(!s.includes(v));});
    await check('query does not use raw snapshot materialization',async()=>{const original=store.previewSnapshot;store.previewSnapshot=()=>{blobReads++;throw Error('raw');};await call();assert.equal(blobReads,0);store.previewSnapshot=original;});
    for (const limit of [0,51,-1,1.5,'1']) await check('reject page limit '+limit,async()=>assert.equal((await call({limit})).code,'invalid_request'));
    for (const cursor of ['bad','0:999999','0:-1']) await check('reject cursor '+cursor,async()=>assert.ok(['invalid_request','stale_evidence'].includes((await call({cursor})).code)));
    await check('client cannot supply file root or native session',async()=>{for(const field of ['path','dataDir','nativeSessionId'])assert.equal((await call({[field]:root})).code,'invalid_request');});
    await check('foreign conversation denied with safe code',async()=>{const r=await call({conversationId:'B'});assert.equal(r.code,'stale_runtime');assert.ok(!JSON.stringify(r).includes(root));});
    await check('stale generation denied',async()=>assert.equal((await call({owner:{...owner,runtimeGeneration:'old'}})).code,'stale_runtime'));
    await check('read-only summary works while Agent running without stopping',async()=>{busy=true;assert.equal((await call()).ok,true);busy=false;});
    await check('authority invalidated during query yields no files',async()=>{stale=true;const r=await call();assert.equal(r.ok,false);assert.equal(r.code,'stale_runtime');assert.equal(r.files,undefined);stale=false;});
    await check('pagination and summary do not mutate journal',async()=>assert.deepEqual(await fs.readFile(journal),before));
    await check('expiration is explicit and removes preview qualification',async()=>{time+=8*86400000;const r=await call();assert.equal(r.expired,true);assert.equal(r.files[0].reason,'expired_evidence');assert.equal(r.files[0].previewEligible,false);time-=8*86400000;});
    await store.gap(scope,'unknown_tool');
    await check('new journal revision rejects old cursor',async()=>assert.equal((await call({cursor:first.nextCursor})).code,'stale_evidence'));
    await check('unknown writes expose attribution gap instead of complete capture',async()=>{const r=await call();assert.equal(r.attributionGap,true);assert.equal(r.evidenceComplete,false);assert.equal(r.files[0].reason,'attribution_gap');});
    await check('workspace epoch isolates evidence',async()=>{const r=await store.queryEvidence({...scope,workspaceEpoch:'other',runtimeOwner:{...owner,workspaceEpoch:'other'}});assert.equal(r.operationCount,0);});
    await check('persistent closed session keeps only its own evidence',async()=>{const r=await store.queryEvidence({projectId:'project',repoId:null,workspaceId:'workspace',workspaceEpoch:'epoch',conversationId:'A',nativeSessionId:'native'});assert.equal(r.operationCount,3);});
    await check('history discovery has no synthetic plan',async()=>assert.deepEqual((await call({},'recover-preview')).plans,[]));
    // Seed historical material in the fixture, without invoking production prepare/apply.
    const backup=await store.restorePut(scope,Buffer.from('historical user backup\n'));
    const candidate=await store.restorePut(scope,Buffer.from('historical candidate\n'));
    await store.applyCreate(scope,{planId:'history',tokenHash:'a'.repeat(64),expiresAt:time+60000,selectedOperationIds:[],files:[{fileId:'f0',relativePath:'file0.txt',currentRef:backup,candidateRef:candidate,state:'prepared'}]});
    const historicalJournal=await fs.readFile(journal);
    await check('query reports real existing history material only',async()=>assert.equal((await call()).files[0].historyAvailable,true));
    await check('history list omits raw refs and confirmation tokens',async()=>{const r=await call({},'recover-preview');assert.equal(r.plans.length,1);assert.equal(r.plans[0].files[0].backupAvailable,true);assert.ok(!JSON.stringify(r).includes('tokenHash'));assert.ok(!JSON.stringify(r).includes(backup.digest));});
    await check('explicit single-file export returns exact backup bytes',async()=>{
      const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/session-revert/export',{method:'POST',headers:{'content-type':'application/json','x-pi-gui-token':'query-token'},body:JSON.stringify({conversationId:'A',owner,sourcePlanId:'history',fileId:'f0',exportName:'backup.bin'})});
      assert.equal(response.status,200);assert.equal(Buffer.from(await response.arrayBuffer()).toString(),'historical user backup\n');
    });
    await check('history reads and export leave existing journal intact',async()=>assert.deepEqual(await fs.readFile(journal),historicalJournal));
    await check('all read-only UI endpoints preserve Git index ref and user file',async()=>{assert.deepEqual(await fs.readFile(path.join(root,'.git/index')),gitIndex);assert.deepEqual(git('rev-parse','HEAD'),gitRef);assert.equal(await fs.readFile(path.join(root,'user.txt'),'utf8'),'existing user content\n');});
  } finally {await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
  console.log(`Session change query: ${checks}/${checks}; failed=0; skipped=0`);
})().catch(e=>{console.error(e);process.exitCode=1;});
