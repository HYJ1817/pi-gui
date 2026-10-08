// Explicit real installed Pi/HTTP startup proof; never included in fixture npm test.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'p33-rpc-')),workspace=path.join(root,'workspace'),data=path.join(root,'data'),agent=path.join(root,'agent');
  for(const dir of [workspace,data,agent])fs.mkdirSync(dir);fs.writeFileSync(path.join(workspace,'user.txt'),'user bytes\r\n');
  fs.writeFileSync(path.join(agent,'settings.json'),JSON.stringify({packages:[],extensions:[],skills:[]}));
  const git=(...args)=>execFileSync('git',['-C',workspace,...args],{windowsHide:true,stdio:'pipe'});
  git('init','--quiet');git('add','user.txt');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','fixture');
  fs.writeFileSync(path.join(data,'projects.json'),JSON.stringify({active:workspace,items:[{path:workspace,name:'Fixture'}]}));
  const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const entry=path.resolve(process.argv[2]||path.join(__dirname,'../server.js'));
  const child=spawn(process.execPath,[entry],{cwd:path.dirname(entry),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:String(port),PI_CWD:workspace,PI_GUI_DATA:data,PI_CODING_AGENT_DIR:agent,PI_GUI_OPEN:'0',PI_NO_CONTINUE:'1',PI_GUI_TOKEN:''}});
  // Raw startup output stays private. Failure reports only stable phase codes.
  let exited=false;child.on('exit',()=>{exited=true;});child.stdout.resume();child.stderr.resume();
  const base=`http://127.0.0.1:${port}`,pause=()=>new Promise(r=>setTimeout(r,100));
  const get=async route=>fetch(base+route,{signal:AbortSignal.timeout(20000)}).then(r=>r.json());
  const post=async body=>fetch(base+'/api/command',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)}).then(r=>r.json());
  let checks=0,eventsAbort;
  const check=(name,fn)=>{fn();checks++;console.log('  ok  '+name);};
  try{
    const deadline=Date.now()+45000;let status;
    while(Date.now()<deadline&&!exited){try{status=await get('/api/status');if(status.state==='ready')break;}catch{}await pause();}
    check('actual backend and real Pi RPC become ready without startup deadlock',()=>assert.equal(status?.state,'ready'));
    let evidence;
    while(Date.now()<deadline){evidence=await get('/api/session-change/evidence');if(evidence.sourceVerified)break;await pause();}
    check('actual explicit file extension source handshake is verified',()=>assert.equal(evidence.sourceVerified,true));
    check('private capture defaults off and no historical B synthesized',()=>{assert.equal(evidence.capture.enabled,false);assert.equal(evidence.operationCount,0);});
    eventsAbort=new AbortController();const stream=await fetch(base+'/api/events',{signal:eventsAbort.signal});const reader=stream.body.getReader();
    const eventPromise=(async()=>{let text='';const timeout=setTimeout(()=>eventsAbort.abort(),20000);try{for(;;){const next=await reader.read();if(next.done)throw Error('confirmation_missing');text+=Buffer.from(next.value).toString('utf8');const frames=text.split('\n\n');text=frames.pop();for(const frame of frames){const row=frame.split('\n').find(s=>s.startsWith('data:'));if(!row)continue;const event=JSON.parse(row.slice(5));if(event.type==='extension_ui_request'&&event.method==='confirm')return event;}}}finally{clearTimeout(timeout);}})();
    assert.equal((await post({type:'prompt',id:'consent-test',message:'/gui-capture enable'})).ok,true);
    const confirm=await eventPromise;
    check('first enable produces actual Pi confirmation UI request',()=>assert.ok(confirm.id));
    assert.equal((await post({type:'extension_ui_response',id:confirm.id,confirmed:true})).ok,true);
    for(let i=0;i<100;i++){evidence=await get('/api/session-change/evidence');if(evidence.capture?.enabled)break;await pause();}
    check('explicit informed confirmation persists enabled state',()=>assert.equal(evidence.capture.enabled,true));
    assert.equal((await post({type:'prompt',id:'disable-test',message:'/gui-capture disable'})).ok,true);
    evidence=await get('/api/session-change/evidence');
    check('backend explicit disable requires no model invocation',()=>assert.equal(evidence.capture.enabled,false));
    check('summary does not expose raw bytes, API URL, token or absolute workspace',()=>{const value=JSON.stringify(evidence);assert.ok(!value.includes(workspace));assert.ok(!value.includes('user bytes'));assert.ok(!value.includes('PI_GUI_SESSION_CHANGE'));});
    const previewBody = {evidenceIds:['fixture-no-evidence'],mode:'confirmed_limited'};
    const previewPost = async body=>fetch(base+'/api/session-revert/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)}).then(r=>r.json());
    const classicPreview=await previewPost({...previewBody,owner:(await get('/api/status')).legacyOwner});
    check('classic actual preview authority returns no evidence without fabricating history',()=>{assert.equal(classicPreview.ok,false);assert.equal(classicPreview.code,'evidence_not_found');});
    check('fixture project user bytes unchanged',()=>assert.equal(fs.readFileSync(path.join(workspace,'user.txt'),'utf8'),'user bytes\r\n'));
    const apiPost=async(route,body)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)}).then(r=>r.json());
    const inventory=await get('/api/worktrees?project='+encodeURIComponent(workspace));
    const plan=await apiPost('/api/worktrees',{action:'prepare',project:workspace,contextGeneration:inventory.contextGeneration});
    const created=await apiPost('/api/worktrees',{action:'create',nonce:plan.nonce,contextGeneration:inventory.contextGeneration});assert.equal(created.ok,true);
    const started=await apiPost('/api/runtime-sessions',{action:'start',args:{id:created.workspace.id,epoch:created.workspace.epoch}});assert.equal(started.ok,true);
    let item, runtimeEvidence;
    for(let i=0;i<150;i++){
      item=(await get('/api/runtime-sessions')).items.find(row=>row.conversationId===started.conversationId);
      runtimeEvidence=await fetch(base+'/api/session-change/evidence',{headers:{'x-pi-gui-conversation':started.conversationId},signal:AbortSignal.timeout(20000)}).then(r=>r.json());
      if(runtimeEvidence.sourceVerified)break;await pause();
    }
    check('managed P32 runtime owner and actual extension handshake are independently bound',()=>{assert.equal(runtimeEvidence.sourceVerified,true);assert.ok(item.owner.sessionId);assert.notEqual(item.owner.sessionId,status.legacyOwner.sessionId);});
    const runtimePreview=await previewPost({...previewBody,conversationId:started.conversationId,owner:item.owner});
    check('managed actual preview uses current owner and workspace authority',()=>{assert.equal(runtimePreview.ok,false);assert.equal(runtimePreview.code,'evidence_not_found');});
    assert.equal((await apiPost('/api/runtime-sessions',{action:'close',owner:item.owner})).ok,true);
    const dormant=await fetch(base+'/api/session-change/evidence',{headers:{'x-pi-gui-conversation':started.conversationId}}).then(r=>r.json());
    check('closed runtime reads persistent evidence metadata through workspace authority',()=>{assert.equal(dormant.ok,true);assert.equal(dormant.sourceVerified,false);assert.equal(dormant.reason,'runtime_closed');assert.equal(dormant.operationCount,0);});
    const dormantPreview=await previewPost({...previewBody,conversationId:started.conversationId});
    check('dormant actual preview requires no invented live owner',()=>{assert.equal(dormantPreview.ok,false);assert.equal(dormantPreview.code,'evidence_not_found');});
    const stale=await apiPost('/api/runtime-sessions',{action:'command',owner:item.owner,command:{type:'prompt',message:'must not run'}});
    check('stale closed owner cannot command a new runtime',()=>assert.equal(stale.code,'stale_runtime'));
    console.log(`Session change REAL RPC ${path.basename(entry)}: ${checks}/${checks}`);
  }finally{
    eventsAbort?.abort();
    if(!exited){if(process.platform==='win32'){try{execFileSync('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}else child.kill('SIGTERM');}
    const limit=Date.now()+5000;while(!exited&&Date.now()<limit)await pause();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(e=>{console.error('Session change real RPC failed:',e.code==='ERR_ASSERTION'?e.message:e.code||e.name);process.exitCode=1;});
