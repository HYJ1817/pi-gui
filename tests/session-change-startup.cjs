// Lifecycle reconciliation must finish before an HTTP read can reach the store.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
(async()=>{
  let checks=0;const check=(name,fn)=>{fn();checks++;console.log('  ok  '+name);};
  const {createSessionEvidenceAdmission}=await import('../server/session-evidence-admission.js');
  const {createSessionRevertRoutes}=await import('../server/session-revert-routes.js');
  let release,initializations=0,authorityCalls=0,dataCalls=0;
  const pending=new Promise(r=>release=r),admission=createSessionEvidenceAdmission(()=>{initializations++;return pending;});
  await Promise.resolve();
  const routes=createSessionRevertRoutes({store:async()=>{dataCalls++;await pending;return {queryEvidence:async()=>({revision:0,gapRevision:0,files:[]}),previewRevision:async()=>({revision:0,gapRevision:0})};},
    withReadAdmission:()=>admission.assertReady(),withAuthority:(_req,_body,fn)=>{authorityCalls++;return fn({scope:{conversationId:'c',workspaceId:'w',workspaceEpoch:'e'},activeWriter:false});}});
  const testServer=require('node:http').createServer((req,res)=>routes.handle(req,res));await new Promise(r=>testServer.listen(0,'127.0.0.1',r));
  const query=()=>fetch('http://127.0.0.1:'+testServer.address().port+'/api/session-revert/query',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(2000)}).then(r=>r.json());
  try{
    const blocked=await query();
    check('slow evidence initialization does not block HTTP response',()=>assert.equal(blocked.code,'evidence_initializing'));
    check('pending request cannot call store or runtime authority',()=>{assert.equal(dataCalls,0);assert.equal(authorityCalls,0);});
    check('initialization is started once independently of requests',()=>assert.equal(initializations,1));
    release();await admission.settled;
    const ready=await query();check('completed initialization opens read admission',()=>assert.equal(ready.ok,true));
    check('new reads do not restart initialization',()=>assert.equal(initializations,1));
    const failed=createSessionEvidenceAdmission(()=>{throw Error('private failure');});await failed.settled;
    check('initialization failure has only a fixed public reason',()=>assert.throws(()=>failed.assertReady(),e=>e.code==='evidence_unavailable'&&e.message==='evidence_unavailable'));
  }finally{release();await new Promise(r=>testServer.close(r));}
  const {createSessionChangeStore}=await import('../server/session-change-store.js');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'p33-startup-')),data=path.join(root,'data');
  const owner={backendInstance:'b',projectId:'p',repoId:null,workspaceId:'w',workspaceEpoch:'e',conversationId:'c',runtimeId:'r',runtimeGeneration:'g',sessionId:'s'};
  const scope={runtimeOwner:owner,conversationId:'c',nativeSessionId:'s',workspaceId:'w',workspaceEpoch:'e'};
  const store=await createSessionChangeStore({dataDir:data});
  await store.configure(scope,{enabled:true,acknowledged:true});
  await store.prepare(scope,{operationId:'interrupted',toolCallId:'tool',path:'fixture.txt',before:Buffer.from('B'),intendedAfter:Buffer.from('A'),effectiveToolSource:'pi-gui-revert'});
  const journal=path.join(data,'revert-evidence/v1/journal.jsonl'),before=await fs.readFile(journal);
  const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const entry=path.resolve(process.argv[2]||path.join(__dirname,'../server.js'));
  const child=spawn(process.execPath,[entry],{cwd:path.dirname(entry),windowsHide:true,stdio:'ignore',env:{...process.env,PORT:String(port),PI_GUI_DATA:data,PI_CWD:'',PI_BIN:'p33-startup-nonexistent-pi',PI_GUI_TOKEN:'',PI_GUI_OPEN:'0'}});
  let exited=false;child.on('exit',()=>exited=true);child.on('error',()=>exited=true);
  const base='http://127.0.0.1:'+port,pause=()=>new Promise(r=>setTimeout(r,75));
  try{
    let ready=false;const deadline=Date.now()+30000;
    while(Date.now()<deadline&&!exited){try{const r=await fetch(base+'/api/status');if(r.ok){ready=true;break;}}catch{}await pause();}
    check('HTTP starts without installing or launching Pi',()=>assert.equal(ready,true));
    let r;
    while(Date.now()<deadline&&!exited){r=await fetch(base+'/api/session-revert/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({conversationId:'nonexistent'})}).then(r=>r.json());if(r.code!=='evidence_initializing')break;await pause();}
    const afterStartup=await fs.readFile(journal),rows=afterStartup.toString().trim().split('\n').map(line=>JSON.parse(JSON.parse(line).body));
    check('pending journal operations are reconciled before read admission opens',()=>{
      assert.ok(afterStartup.length>before.length);
      assert.equal(rows.filter(r=>r.type==='operation').at(-1).record.state,'incomplete');
      assert.equal(rows.at(-1).type,'gap');
    });
    check('unauthorized scope is refused instead of inventing history',()=>{assert.equal(r.ok,false);assert.equal(r.code,'evidence_not_found');});
    const afterQuery=await fs.readFile(journal);
    check('HTTP query adds no journal reconciliation records',()=>assert.deepEqual(afterQuery,afterStartup));
    check('GUI service survives rejected query',()=>assert.equal(exited,false));
    console.log(`Session change startup ${path.basename(entry)}: ${checks}/${checks}; failed=0; skipped=0`);
  }finally{if(!exited)child.kill();for(let i=0;i<60&&!exited;i++)await pause();assert.ok(exited,'owned fixture backend must exit');await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e.code==='ERR_ASSERTION'?e.message:e.code||e.name);process.exitCode=1;});
