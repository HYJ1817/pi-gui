const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let passed=0;async function check(name,run){await run();passed++;console.log('PASS '+name);}
(async()=>{
 let createSessionToolBridge;try{({createSessionToolBridge}=await import('../server/session-tool-bridge.js'));}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
 assert.equal(typeof createSessionToolBridge,'function','private per-launch tool guard is required');
 const {createSessionToolScheduler}=await import('../server/session-tool-scheduler.js');
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-tool-private-')),scheduler=createSessionToolScheduler();let native='native-A';
 const a=createSessionToolBridge({scheduler,launch:{},getCwd:()=>world,readState:async()=>({sessionId:native}),supported:true});
 const b=createSessionToolBridge({scheduler,launch:{},getCwd:()=>world,readState:async()=>({sessionId:'native-B'}),supported:true});
 // Match the extension's Node HTTP transport: fetch applies browser forbidden-
 // port rules even to an OS-assigned loopback port (e.g. 6667 on Windows).
 const send=(spec,action,body={},token=spec.env.PI_GUI_TOOL_TOKEN,origin)=>new Promise((resolve,reject)=>{
  const request=require('node:http').request(spec.env.PI_GUI_TOOL_URL+'/'+action,{method:'POST',headers:{'content-type':'application/json','x-pi-gui-tool-token':token,...(origin?{origin}:{})}},response=>{
    let data='';response.on('data',chunk=>{data+=chunk;});response.on('end',()=>{try{resolve({status:response.statusCode,...JSON.parse(data)});}catch(error){reject(error);}});
  });request.on('error',reject);request.end(JSON.stringify(body));
 });
 try{
  const sa=await a.prepare(),sb=await b.prepare();
  // Contract excerpts from Pi 1.6.0's public declarations. No installed Pi,
  // credentials, global npm directory or external model is used by this suite.
  const types=`export interface ExtensionAPI {
    on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): () => void;
    on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): () => void;
    on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): () => void;
    on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): () => void;
    on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): () => void;
    getAllTools(): ToolInfo[];
  }
  export interface ToolCallEventResult { block?: boolean; reason?: string; }
  export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;`;
  const pkg=path.join(world,'pi-package'),typeFile=path.join(pkg,'dist/core/extensions/types.d.ts'),managerFile=path.join(pkg,'dist/core/session-manager.d.ts');
  fs.mkdirSync(path.dirname(typeFile),{recursive:true});fs.writeFileSync(typeFile,types);fs.writeFileSync(managerFile,'export declare class SessionManager { getSessionId(): string; }');
  const {probeSessionToolGuard,createPiProbes}=await import('../server/pi-probes.js');
  const production=()=>createSessionToolBridge({scheduler,launch:{packageDir:()=>pkg},getCwd:()=>world,readState:async()=>({sessionId:'native-contract'})});
  await check('Pi 1.6 contract is installed without a version bypass but still requires a real session handshake',async()=>{
    fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.6.0'}));
    const guard=production();try{const spec=await guard.prepare();assert.ok(spec,'compatible 1.6 package was incorrectly rejected');assert.deepEqual(guard.status(),{installed:true,verified:false});assert.equal(guard.ready(),false);
      assert.equal((await send(spec,'hello',{sessionId:'foreign'})).ok,false);assert.equal(guard.ready(),false);
      assert.equal((await send(spec,'hello',{sessionId:'native-contract'})).ok,true);await guard.assertReady();assert.equal(guard.ready(),true);
    }finally{await guard.dispose();guard.confirmCleanup();}
  });
  await check('contract probe is version independent and diagnostics reuse the exact admission verdict',async()=>{
    fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:'99.0.0-fork'}));
    assert.equal(probeSessionToolGuard(pkg).state,true);
    assert.equal(createPiProbes({resolvePackageDir:()=>pkg}).report().probes.find(p=>p.id==='session-tool-guard').state,true);
    const guard=production();try{assert.ok(await guard.prepare());assert.equal(guard.ready(),false);}finally{await guard.dispose();guard.confirmCleanup();}
  });
  await check('each required hook, blocking result and identity API is mandatory even for formerly allowlisted versions',async()=>{
    fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:'1.2.0'}));
    for(const part of ['session_start','tool_call','tool_result','tool_execution_end','agent_settled','getAllTools','block?','Promise']){
      fs.writeFileSync(typeFile,types.replaceAll(part,'missing_contract'));assert.equal(probeSessionToolGuard(pkg).state,false,part);
      const guard=production();try{assert.equal(await guard.prepare(),null,part);await assert.rejects(()=>guard.assertReady(),e=>e.code==='tool_guard_unavailable');}finally{await guard.dispose();guard.confirmCleanup();}
    }
    fs.writeFileSync(typeFile,types);fs.writeFileSync(managerFile,'export declare class SessionManager {}');assert.equal(probeSessionToolGuard(pkg).state,false);
    fs.writeFileSync(managerFile,'export declare class SessionManager { getSessionId(): string; }');
  });
  await check('unreadable, oversized and absent capability evidence stays unknown, not ready',async()=>{
    fs.writeFileSync(typeFile,'x'.repeat(512*1024+1));assert.equal(probeSessionToolGuard(pkg).state,null);
    fs.rmSync(typeFile);fs.mkdirSync(typeFile);assert.equal(probeSessionToolGuard(pkg).state,null);fs.rmdirSync(typeFile);
    assert.equal(probeSessionToolGuard(pkg).state,null);assert.equal(probeSessionToolGuard(null).state,null);
    const guard=production();try{assert.equal(await guard.prepare(),null);assert.equal(guard.ready(),false);}finally{await guard.dispose();guard.confirmCleanup();}
    fs.writeFileSync(typeFile,types);
  });
  await check('readiness awaits native hello and rejects invalidation instead of declaring success',async()=>{
    const guard=production();try{const spec=await guard.prepare();let complete=false;const pending=guard.assertReady().then(()=>{complete=true;});
      await new Promise(r=>setTimeout(r,30));assert.equal(complete,false);await send(spec,'hello',{sessionId:'native-contract'});await pending;assert.equal(complete,true);
      guard.invalidate();assert.equal(guard.ready(),false);await assert.rejects(()=>guard.assertReady(),e=>e.code==='tool_guard_unavailable');
    }finally{await guard.dispose();guard.confirmCleanup();}
  });
  await check('private endpoint refuses browser origins, foreign tokens and claimed paths',async()=>{
   assert.equal((await send(sa,'hello',{sessionId:'native-A'},'wrong')).status,403);
   assert.equal((await send(sa,'hello',{sessionId:'native-A'},undefined,'http://localhost')).status,403);
   assert.equal((await send(sa,'hello',{sessionId:'native-A',root:world})).ok,false);
  });
  await check('handshake binds authoritative native session and never exposes capability',async()=>{
   assert.equal((await send(sa,'hello',{sessionId:'wrong'})).ok,false);
   assert.equal((await send(sa,'hello',{sessionId:'native-A'})).ok,true);assert.equal(a.ready(world,'native-A'),true);
   assert.equal((await send(sb,'hello',{sessionId:'native-B'})).ok,true);assert.ok(!JSON.stringify(a.status()).includes(sa.env.PI_GUI_TOOL_TOKEN));
  });
  await check('same-directory private calls queue and Stop cancels only waiting B',async()=>{
   assert.equal((await send(sa,'begin',{sessionId:'native-A',callId:'lease-A',toolCallId:'shared-id',readOnly:false})).ok,true);
   let done=false;const waiting=send(sb,'begin',{sessionId:'native-B',callId:'lease-B',toolCallId:'shared-id',readOnly:false}).then(v=>{done=true;return v;});
   await new Promise(r=>setTimeout(r,20));assert.equal(done,false);b.pause();assert.equal((await waiting).ok,false);
   assert.equal((await send(sa,'end',{sessionId:'native-A',callId:'lease-A'})).ok,true);b.resume();
  });
  await check('native session drift and rotated capability reject stale requests',async()=>{
   native='new-A';assert.equal((await send(sa,'begin',{sessionId:'native-A',callId:'late',toolCallId:'x',readOnly:false})).ok,false);
   const next=await a.prepare();assert.equal((await send(sa,'hello',{sessionId:'new-A'})).status,403);
   assert.equal((await send(next,'hello',{sessionId:'new-A'})).ok,true);
  });
  await check('candidate evidence hook is awaited and never creates approval decisions',async()=>{
    const seen=[];let release;const gate=new Promise(r=>{release=r;});
    const audit=createSessionToolBridge({scheduler,launch:{},getCwd:()=>world,readState:async()=>({sessionId:'audit-native'}),supported:true,
      audit:async event=>{seen.push(event.phase);if(event.phase==='begin')await gate;}});
    try{
      const spec=await audit.prepare();await send(spec,'hello',{sessionId:'audit-native'});
      let accepted=false;const begin=send(spec,'begin',{sessionId:'audit-native',callId:'audited',toolCallId:'write-1',readOnly:false,audit:{kind:'write',path:'file.txt',expectedHash:'a'.repeat(64)}}).then(v=>{accepted=true;return v;});
      await new Promise(r=>setTimeout(r,20));assert.equal(accepted,false);release();assert.equal((await begin).ok,true);
      assert.equal((await send(spec,'end',{sessionId:'audit-native',callId:'audited'})).ok,true);assert.deepEqual(seen,['begin','end']);
    }finally{await audit.dispose();audit.confirmCleanup();}
  });
  await check('bundled write wrapper file URL retains intended-byte evidence',async()=>{
    const {installToolGuard}=await import('../extensions/pi-gui-tool-guard/index.js');const hooks=new Map(),sent=[];
    const source=path.join(world,'bundled-revert.js');
    const pi={on:(name,fn)=>hooks.set(name,fn),getAllTools:()=>[{name:'write',sourceInfo:{source:'extension',path:require('node:url').pathToFileURL(source).href}}]};
    installToolGuard(pi,{audit:true,revertSource:source,post:async(action,body)=>{sent.push({action,body});return{ok:true};}});
    await hooks.get('tool_call')({toolName:'write',toolCallId:'wrapper',input:{path:'file.txt',content:'fixture bytes'}},{cwd:world,sessionManager:{getSessionId:()=> 'native-wrapper'}});
    const begin=sent.find(v=>v.action==='begin');assert.equal(begin.body.audit.kind,'write');assert.equal(begin.body.audit.path,'file.txt');assert.match(begin.body.audit.expectedHash,/^[a-f0-9]{64}$/);assert(!JSON.stringify(sent).includes('fixture bytes'));
  });
  await check('proven unrelated extension_error does not revoke the current guard, even with the same basename',async()=>{
    const foreign=path.join(world,'unrelated','index.js');fs.mkdirSync(path.dirname(foreign));fs.writeFileSync(foreign,'// fixture extension');
    const guard=production();try{const spec=await guard.prepare();await send(spec,'hello',{sessionId:'native-contract'});
      guard.observe({type:'extension_error',extensionPath:foreign,event:'agent_start',error:'must not be recorded'});
      assert.equal(guard.ready(),true,'an unrelated extension must not revoke this capability');await guard.assertReady();
    }finally{await guard.dispose();guard.confirmCleanup();}
  });
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async fn=>{const deadline=Date.now()+3000;while(!fn()){assert.ok(Date.now()<deadline,'bounded fixture timeout');await wait(5);}};
  async function fixture(options,run){const guard=createSessionToolBridge({scheduler,launch:{},getCwd:()=>world,readState:async()=>({sessionId:'native-fixture'}),supported:true,retryDelayMs:1,...options});
    try{const spec=await guard.prepare();await run(guard,spec);}finally{await guard.dispose();guard.confirmCleanup();}}
  for(const kind of ['guard-path','guard-url','missing','relative','synthetic','nonexistent'])await check('guard/unknown extension_error remains terminal: '+kind,()=>fixture({},async(guard,spec)=>{
    await send(spec,'hello',{sessionId:'native-fixture'});
    const source=kind==='guard-path'?spec.args[1]:kind==='guard-url'?require('node:url').pathToFileURL(spec.args[1]).href:kind==='relative'?'index.js':kind==='synthetic'?'command:example':kind==='nonexistent'?path.join(world,'absent.js'):undefined;
    guard.observe({type:'extension_error',extensionPath:source,event:'agent_start',error:'raw-secret-path-must-not-escape'});
    assert.equal(guard.ready(),false);assert.equal(guard.resume(),false);
    assert.equal((await send(spec,'hello',{sessionId:'native-fixture'})).ok,false);
    await assert.rejects(()=>guard.assertReady(),error=>error.code==='tool_guard_unavailable'&&!error.message.includes('raw-secret'));
  }));
  const {installToolGuard,toolTransport}=await import('../extensions/pi-gui-tool-guard/index.js');
  function extension(spec,post){const hooks=new Map();const installed=installToolGuard({on:(type,fn)=>hooks.set(type,fn),getAllTools:()=>[{name:'write',sourceInfo:{source:'builtin',path:'builtin:write',scope:'temporary',origin:'top-level'}}]},
    {url:spec.env.PI_GUI_TOOL_URL,token:spec.env.PI_GUI_TOOL_TOKEN,retryDelayMs:1,...(post?{post}:{})});
    const ctx={cwd:world,sessionManager:{getSessionId:()=> 'native-fixture'}};return{hooks,installed,ctx};}
  await check('first hello transport failure recovers without a prompt and tool_call joins the same initialization',()=>fixture({},async(guard,spec)=>{
    let hellos=0,begins=0,release;const gate=new Promise(resolve=>{release=resolve;});
    const x=extension(spec,async(action,body,options)=>{if(action==='hello'&&++hellos===1){await gate;throw Error('synthetic transient');}if(action==='begin')begins++;return toolTransport({url:spec.env.PI_GUI_TOOL_URL,token:spec.env.PI_GUI_TOOL_TOKEN},action,body,options);});
    try{const returned=x.hooks.get('session_start')({},x.ctx);assert.equal(returned,undefined,'must not block Pi stdin binding');const initialized=guard.assertReady();
      const call=x.hooks.get('tool_call')({toolName:'write',toolCallId:'once',input:{}},x.ctx);release();await Promise.all([initialized,call]);
      assert.equal(hellos,2);assert.equal(begins,1);assert.equal(guard.ready(world,'native-fixture'),true);assert.equal(x.installed.status().failed,false);
      await x.hooks.get('tool_execution_end')({toolCallId:'once'});
    }finally{x.installed.dispose();}
  }));
  await check('initial hello retry exhaustion is finite and terminal; ordinary tool retry cannot fabricate hello',()=>fixture({},async(guard,spec)=>{
    let hellos=0,faults=0,begins=0;
    const x=extension(spec,async(action,body,options)=>{if(action==='hello'){hellos++;throw Error('opaque private transport failure');}if(action==='fault')faults++;if(action==='begin')begins++;return toolTransport({url:spec.env.PI_GUI_TOOL_URL,token:spec.env.PI_GUI_TOOL_TOKEN},action,body,options);});
    try{x.hooks.get('session_start')({},x.ctx);await assert.rejects(()=>guard.assertReady(),error=>error.code==='tool_guard_unavailable');
      await until(()=>x.installed.status().failed);assert.equal(hellos,3);assert.equal(faults,1);
      await assert.rejects(()=>x.hooks.get('tool_call')({toolName:'write',toolCallId:'never',input:{}},x.ctx));assert.equal(hellos,3);assert.equal(begins,0);assert.equal(guard.ready(),false);
    }finally{x.installed.dispose();}
  }));
  await check('concurrent readiness checks share bounded transient read recovery and keep the real hello binding',async()=>{
    let failing=0,reads=0;
    await fixture({readState:async()=>{reads++;return failing-- >0?null:{sessionId:'native-fixture'};}},async(guard,spec)=>{
      await send(spec,'hello',{sessionId:'native-fixture'});reads=0;failing=2;
      await Promise.all([guard.assertReady(),guard.assertReady(),guard.assertReady()]);assert.equal(reads,3);assert.equal(guard.ready(),true);
    });
  });
  for(const field of ['owner','native','sessionEpoch','bridge','cwd','stop'])await check('full witness rejects identity change across hello readback: '+field,async()=>{
    let release,entered=false;const gate=new Promise(resolve=>{release=resolve;});
    const identity={owner:'generation-one',native:null,sessionEpoch:0,bridge:'process-one',cwd:world,stop:false};
    const capture=sessionId=>({...identity,sessionId});
    const isCurrent=w=>!identity.stop&&Object.entries(w).every(([key,value])=>key==='sessionId'||key==='native'&&value===null?(identity.native===null||identity.native===w.sessionId):identity[key]===value);
    await fixture({capture,isCurrent,readState:async()=>{entered=true;await gate;return{sessionId:'native-fixture'};}},async(guard,spec)=>{
      const hello=send(spec,'hello',{sessionId:'native-fixture'});await until(()=>entered);
      identity[field]=field==='stop'?true:field==='sessionEpoch'?1:'replacement';release();assert.equal((await hello).ok,false);assert.equal(guard.ready(),false);
    });
  });
  await check('initial null owner binds only the actual native and refuses wrong-native readiness',async()=>{
    let owned=null;
    await fixture({capture:sessionId=>({sessionId,owned}),isCurrent:w=>(w.owned===null||w.owned===w.sessionId)&&(owned===null||owned===w.sessionId)},async(guard,spec)=>{
      assert.equal((await send(spec,'hello',{sessionId:'wrong-native'})).ok,false);
      assert.equal((await send(spec,'hello',{sessionId:'native-fixture'})).ok,true);owned='native-fixture';await guard.assertReady();
      assert.equal(guard.ready(world,'wrong-native'),false);assert.equal(guard.ready(world,'native-fixture'),true);owned='replacement';assert.equal(guard.ready(),false);
    });
  });
  await check('Stop pause invalidates an in-flight hello; late success cannot resume the scheduler',async()=>{
    let release,entered=false,stopping=false;const gate=new Promise(resolve=>{release=resolve;});
    await fixture({capture:sessionId=>({sessionId}),isCurrent:()=>!stopping,readState:async()=>{entered=true;await gate;return{sessionId:'native-fixture'};}},async(guard,spec)=>{
      const hello=send(spec,'hello',{sessionId:'native-fixture'});await until(()=>entered);stopping=true;guard.pause();release();
      assert.equal((await hello).ok,false);assert.equal(guard.resume(),false);assert.equal(guard.ready(),false);
      stopping=false;assert.equal(guard.resume(),false,'late hello did not establish a native binding');
    });
  });
  await check('initialization deadline rejects late hello and cancels readiness timers',async()=>{
    let release,entered=false;const gate=new Promise(resolve=>{release=resolve;});
    await fixture({initializationMs:30,readTimeoutMs:1000,readState:async()=>{entered=true;await gate;return{sessionId:'native-fixture'};}},async(guard,spec)=>{
      const initial=guard.assertReady();const hello=send(spec,'hello',{sessionId:'native-fixture'});await until(()=>entered);
      await assert.rejects(()=>initial,error=>error.code==='tool_guard_unavailable');release();assert.equal((await hello).ok,false);assert.equal(guard.ready(),false);
    });
  });
  await check('rotated process token rejects old late hello/tool and cannot touch a new writer',async()=>{
    let held=false,entered=false,release;const gate=new Promise(resolve=>{release=resolve;});
    await fixture({readState:async()=>{if(held){entered=true;await gate;}return{sessionId:'native-fixture'};}},async(guard,spec)=>{
      held=true;const oldHello=send(spec,'hello',{sessionId:'native-fixture'});await until(()=>entered);const next=await guard.prepare();held=false;release();
      assert.equal((await oldHello).ok,false);assert.equal((await send(next,'hello',{sessionId:'native-fixture'})).ok,true);
      assert.equal((await send(spec,'begin',{sessionId:'native-fixture',callId:'old',toolCallId:'old',readOnly:false})).ok,false);
      assert.equal((await send(next,'begin',{sessionId:'native-fixture',callId:'new',toolCallId:'new',readOnly:false})).ok,true);
      assert.equal((await send(spec,'end',{sessionId:'native-fixture',callId:'new'})).ok,false);assert.equal(scheduler.busy(),true);
      await send(next,'end',{sessionId:'native-fixture',callId:'new'});
    });
  });
  await check('revocation retains an unconfirmed active writer until its own execution_end; B waits safely',()=>fixture({},async(a,sa)=>fixture({readState:async()=>({sessionId:'native-B2'})},async(b,sb)=>{
    await send(sa,'hello',{sessionId:'native-fixture'});await send(sb,'hello',{sessionId:'native-B2'});
    await send(sa,'begin',{sessionId:'native-fixture',callId:'active',toolCallId:'same',readOnly:false});let finished=false;
    const waiting=send(sb,'begin',{sessionId:'native-B2',callId:'waiting',toolCallId:'same',readOnly:false}).then(result=>{finished=true;return result;});
    a.invalidate();assert.equal(a.resume(),false);await wait(20);assert.equal(finished,false);assert.equal(scheduler.busy(),true);
    assert.equal((await send(sa,'hello',{sessionId:'native-fixture'})).ok,false);
    assert.equal((await send(sa,'end',{sessionId:'native-fixture',callId:'active'})).ok,true);assert.equal((await waiting).ok,true);
    await send(sb,'end',{sessionId:'native-B2',callId:'waiting'});
  })));
  await check('duplicate begin cannot release the existing active writer',()=>fixture({},async(a,sa)=>fixture({readState:async()=>({sessionId:'native-B3'})},async(b,sb)=>{
    await send(sa,'hello',{sessionId:'native-fixture'});await send(sb,'hello',{sessionId:'native-B3'});
    const begin={sessionId:'native-fixture',callId:'duplicate',toolCallId:'same',readOnly:false};await send(sa,'begin',begin);
    assert.equal((await send(sa,'begin',begin)).ok,false);let done=false;
    const pending=send(sb,'begin',{sessionId:'native-B3',callId:'other',toolCallId:'same',readOnly:false}).then(result=>{done=true;return result;});await wait(20);assert.equal(done,false);
    await send(sa,'end',{sessionId:'native-fixture',callId:'duplicate'});assert.equal((await pending).ok,true);await send(sb,'end',{sessionId:'native-B3',callId:'other'});
  })));
  await check('granted lease survives revocation during audit and only confirmed cleanup releases it',async()=>{
    let release,entered=false;const gate=new Promise(resolve=>{release=resolve;});
    await fixture({audit:async event=>{if(event.phase==='begin'){entered=true;await gate;}}},async(a,sa)=>fixture({readState:async()=>({sessionId:'native-B4'})},async(b,sb)=>{
      await send(sa,'hello',{sessionId:'native-fixture'});await send(sb,'hello',{sessionId:'native-B4'});
      const pending=send(sa,'begin',{sessionId:'native-fixture',callId:'unconfirmed',toolCallId:'same',readOnly:false});await until(()=>entered);a.invalidate();release();assert.equal((await pending).ok,false);
      let done=false;const next=send(sb,'begin',{sessionId:'native-B4',callId:'next',toolCallId:'same',readOnly:false}).then(result=>{done=true;return result;});await wait(20);assert.equal(done,false);
      await a.dispose();assert.equal(done,false);a.confirmCleanup();assert.equal((await next).ok,true);await send(sb,'end',{sessionId:'native-B4',callId:'next'});
    }));
  });
  await check('extension session_start does not clear outstanding leases and old native end retains its owner',async()=>{
    const hooks=new Map(),sent=[];let native='first';
    const installed=installToolGuard({on:(type,fn)=>hooks.set(type,fn),getAllTools:()=>[{name:'write',sourceInfo:{source:'builtin'}}]}, {post:async(action,body)=>{sent.push({action,body});return{ok:true};}});
    const ctx={cwd:world,sessionManager:{getSessionId:()=>native}};
    try{await hooks.get('tool_call')({toolName:'write',toolCallId:'owned',input:{}},ctx);native='second';hooks.get('session_start')({},ctx);
      assert.equal(installed.status().leases,1);await hooks.get('tool_execution_end')({toolCallId:'owned'});
      assert.equal(sent.find(item=>item.action==='end').body.sessionId,'first');assert.equal(installed.status().leases,0);
    }finally{installed.dispose();}
  });
  await check('extension source drift after an awaited begin rejects execution but retains the unknown lease',async()=>{
    const hooks=new Map();let source='builtin';const installed=installToolGuard({on:(type,fn)=>hooks.set(type,fn),getAllTools:()=>[{name:'read',sourceInfo:{source,path:source}}]},
      {post:async action=>{if(action==='begin')source='extension';return{ok:true};}});
    try{await assert.rejects(()=>hooks.get('tool_call')({toolName:'read',toolCallId:'source',input:{}},{cwd:world,sessionManager:{getSessionId:()=> 'native-source'}}),error=>error.code==='stale_runtime');
      assert.equal(installed.status().leases,1);await hooks.get('agent_settled')();assert.equal(installed.status().leases,0);
    }finally{installed.dispose();}
  });
  await check('a completed Stop invalidates both the old readiness proof and an in-flight read, not the next explicit attempt',async()=>{
    let entered=false,release,hold=false;const gate=new Promise(resolve=>{release=resolve;});
    await fixture({readState:async()=>{if(hold){entered=true;await gate;}return{sessionId:'native-fixture'};}},async(guard,spec)=>{
      await send(spec,'hello',{sessionId:'native-fixture'});const proof=await guard.assertReady(),before=guard.revision();
      assert.equal(proof(),true);hold=true;const pending=guard.assertReady();await until(()=>entered);
      guard.pause();assert.equal(guard.resume(),true);hold=false;release();
      await assert.rejects(()=>pending,error=>error.code==='stale_runtime');
      assert.ok(guard.revision()>before);assert.equal(proof(),false);assert.equal(guard.ready(),true);
      const fresh=await guard.assertReady();assert.equal(fresh(),true);
    });
  });
  // Exercise the real Classic owner assembly and original RPC mutation ledger.
  // Only the external Pi child is a fixture; no parallel mutation bookkeeping.
  const {createRpcBridge}=await import('../server/rpc-bridge.js');
  const {createRuntime}=await import('../server/runtime.js');
  const {EventEmitter}=require('node:events'),vm=require('node:vm');
  const serverSource=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const classicAssembly=serverSource.slice(serverSource.indexOf('function primaryToolOwner('),serverSource.indexOf('const processAdmission ='));
  assert.ok(classicAssembly.includes('const primaryToolGuard ='),'test must execute actual Classic guard assembly');
  async function classic(run){
    let guard,cache='A',native='A',source='pi-fixture',cwd=world,heldReads=false,child;
    const writes=[],reads=[];
    const identity={backendInstance:'fixture',projectId:'P',repoId:'P',workspaceId:'P',workspaceEpoch:'one',conversationId:'classic-chat',runtimeId:'classic',runtimeGeneration:'one'};
    const runtime={...createRuntime({initialCwd:world}),getCurrentCwd:()=>cwd};
    const scope={primarySessionWitnessEpoch:0};
    const reply=(cmd,success=true,data={})=>child.stdout.emit('data',JSON.stringify({type:'response',id:cmd.id,command:cmd.type,success,...(success?{data}:{error:'fixture rejection'})})+'\n');
    const state=()=>({sessionId:native,isStreaming:false,isCompacting:false,pendingMessageCount:0});
    const rpc=createRpcBridge({runtime,isWin:false,piBin:'fixture',autoRestart:false,env:{PI_NO_CONTINUE:'1'},
      toolLaunch:{available:()=>false,pause:()=>guard?.pause(),invalidate:()=>guard?.invalidate()},
      publish:event=>{if(event.type==='response'&&event.command==='get_state'&&event.success===true){cache=event.data.sessionId;scope.primarySessionWitnessEpoch=rpc.providerSessionEpoch();}},
      spawnProcess(){child=new EventEmitter();child.pid=42042;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
        child.stdout.setEncoding=child.stderr.setEncoding=()=>{};child.stdin=new EventEmitter();child.stdin.end=()=>{};
        child.stdin.write=line=>{const cmd=JSON.parse(line);writes.push(cmd);
          if(['switch_session','new_session','fork'].includes(cmd.type))return;
          if(cmd.type==='get_state'&&heldReads){reads.push({cmd,data:state()});return;}
          queueMicrotask(()=>reply(cmd,true,cmd.type==='get_state'?state():cmd.type==='clear_queue'?{steering:[],followUp:[]}:{}));};
        child.kill=()=>{queueMicrotask(()=>child.emit('exit',0,null));return true;};queueMicrotask(()=>child.emit('spawn'));return child;}});
    Object.assign(scope,{rpc,runtime,toolScheduler:scheduler,piLaunch:{identityKey:()=>source},toolWorkspaceRoot:()=>world,
      primaryOwner:()=>({...identity,sessionId:cache}),sameClassicOwner:(a,b)=>a&&Object.keys(a).length===Object.keys(b).length&&Object.keys(b).every(k=>a[k]===b[k]),
      createSessionToolBridge:options=>createSessionToolBridge({...options,supported:true,initializationMs:1000,readTimeoutMs:80,retryDelayMs:1}),publishClassicExecution:()=>{}});
    guard=vm.runInNewContext(classicAssembly+'\nprimaryToolGuard',scope);
    try{rpc.start();await until(()=>rpc.getState().state==='ready');scope.primarySessionWitnessEpoch=rpc.providerSessionEpoch();
      const spec=await guard.prepare();
      const f={guard,spec,rpc,writes,identity,scope,cache:()=>cache,native:value=>{native=value;},source:value=>{source=value;},cwd:value=>{cwd=value;},child:()=>child,
        mutation:success=>reply(writes.findLast(cmd=>['switch_session','new_session','fork'].includes(cmd.type)),success),
        hold:()=>{heldReads=true;},waiting:()=>reads.length,release:()=>{heldReads=false;for(const read of reads.splice(0))reply(read.cmd,true,read.data);},
        reads:()=>writes.filter(cmd=>cmd.type==='get_state').length};
      await run(f);
    }finally{runtime.setShuttingDown(true);rpc.stop();await guard.dispose();guard.confirmCleanup();}
  }
  function classicExtension(f,onInitializing=()=>{}){
    const hooks=new Map(),helloCodes=[],timeouts=[],signals=[];let hellos=0;
    const connection={url:f.spec.env.PI_GUI_TOOL_URL,token:f.spec.env.PI_GUI_TOOL_TOKEN};
    let current='A';const ctx={cwd:world,sessionManager:{getSessionId:()=>current}};
    const installed=installToolGuard({on:(type,fn)=>hooks.set(type,fn),getAllTools:()=>[{name:'write',sourceInfo:{source:'builtin'}}]},
      {...connection,retryDelayMs:1,post:async(action,body,options)=>{
        if(action==='hello'){hellos++;timeouts.push(options.timeoutMs);signals.push(options.signal);}
        try{return await toolTransport(connection,action,body,options);}catch(error){
          if(action==='hello'){helloCodes.push(error.code);if(error.code==='tool_guard_initializing')await onInitializing();}throw error;}
      }});
    return {hooks,ctx,installed,helloCodes,timeouts,signals,hellos:()=>hellos,start:value=>{current=value;hooks.get('session_start')({},ctx);},
      call:id=>hooks.get('tool_call')({toolName:'write',toolCallId:id,input:{}},ctx),end:id=>hooks.get('tool_execution_end')({toolCallId:id})};
  }
  await check('Classic rejected mutation permits a fresh strict same-native proof, never the old proof/input',()=>classic(async f=>{
    await send(f.spec,'hello',{sessionId:'A'});const old=await f.guard.assertReady(),input=f.rpc.captureCommandGuard({type:'prompt'});
    f.rpc.send({type:'switch_session',id:'reject'});assert.equal(f.rpc.providerSessionChanging(),true);assert.equal(old(),false);
    f.mutation(false);assert.equal(f.rpc.providerSessionChanging(),false);const before=f.reads(),fresh=await f.guard.assertReady();
    assert.ok(f.reads()>before);assert.equal(fresh(),true);assert.equal(old(),false);assert.throws(input,error=>error.code==='stale_runtime');
    assert.equal((await send(f.spec,'begin',{sessionId:'A',callId:'fresh-A',toolCallId:'fresh-A',readOnly:false})).ok,true);
    await send(f.spec,'end',{sessionId:'A',callId:'fresh-A'});assert.equal(f.writes.some(cmd=>cmd.type==='prompt'),false);
  }));
  await check('Classic old awaited readiness cannot be washed clean by a rejected mutation and fresh capture',()=>classic(async f=>{
    await send(f.spec,'hello',{sessionId:'A'});f.hold();const old=f.guard.assertReady();await until(()=>f.waiting());
    f.rpc.send({type:'switch_session'});f.mutation(false);f.release();await assert.rejects(()=>old,error=>error.code==='stale_runtime');
    assert.equal((await f.guard.assertReady())(),true);
  }));
  await check('Classic real B session_start before mutation response retries without authority or cache B',()=>classic(async f=>{
    let hints=0;const x=classicExtension(f,async()=>{hints++;assert.equal(f.guard.ready(world,'B'),false);assert.equal(f.rpc.providerSessionChanging(),true);f.mutation(true);assert.equal(f.cache(),'A');
      await assert.rejects(()=>f.guard.assertReady(),error=>error.code==='stale_runtime','old-native shared admission must fail without poisoning the pending real B hello');
      assert.equal(f.guard.ready(world,'B'),false);
    });
    try{x.start('A');await f.guard.assertReady();await until(()=>x.installed.status().verified);const old=await f.guard.assertReady();
      f.rpc.send({type:'switch_session'});f.native('B');const before=x.hellos();x.start('B');await x.call('B-after-transition');
      assert.equal(hints,1);assert.equal(x.hellos()-before,2);assert.equal(x.helloCodes.at(-1),'tool_guard_initializing');
      assert.equal(x.signals.at(-1),x.signals.at(-2));assert.ok(x.timeouts.at(-1)<=x.timeouts.at(-2));
      assert.equal(x.installed.status().failed,false);assert.equal(f.guard.ready(world,'B'),true);assert.equal(f.cache(),'A');assert.equal(old(),false);
      await x.end('B-after-transition');assert.equal(f.writes.some(cmd=>cmd.type==='prompt'),false);
      f.rpc.send({type:'get_state',id:'cache-B'});await until(()=>f.cache()==='B');assert.equal((await f.guard.assertReady())(),true);
    }finally{x.installed.dispose();}
  }));
  await check('Classic B hello after mutation completion does not depend on delayed public owner readback',()=>classic(async f=>{
    const x=classicExtension(f);try{x.start('A');await f.guard.assertReady();await until(()=>x.installed.status().verified);
      f.rpc.send({type:'switch_session'});f.native('B');f.mutation(true);assert.equal(f.cache(),'A');const before=x.hellos();x.start('B');await x.call('B-cache-lag');
      assert.equal(x.hellos()-before,1);assert.equal(x.installed.status().failed,false);assert.equal(f.guard.ready(world,'B'),true);await x.end('B-cache-lag');
    }finally{x.installed.dispose();}
  }));
  await check('unknown mutation timeout never authorizes B; all three initializing retries exhaust terminally',()=>classic(async f=>{
    const x=classicExtension(f);try{x.start('A');await f.guard.assertReady();await until(()=>x.installed.status().verified);
      assert.equal(await f.rpc.request({type:'switch_session'},{timeoutMs:5}),null);assert.equal(f.rpc.providerSessionChanging(),true);
      f.native('B');const before=x.hellos();x.start('B');await until(()=>x.installed.status().failed);await until(()=>!f.guard.status().verified);
      assert.equal(x.hellos()-before,3);assert.deepEqual(x.helloCodes.slice(-3),Array(3).fill('tool_guard_initializing'));
      assert.equal(f.guard.ready(world,'B'),false);assert.equal(f.rpc.providerSessionChanging(),true);
      f.mutation(true);await assert.rejects(()=>x.call('never-revive'));assert.equal(x.hellos()-before,3);
      await assert.rejects(()=>f.guard.assertReady(),error=>error.code==='tool_guard_unavailable');assert.equal(f.writes.some(cmd=>cmd.type==='prompt'),false);
    }finally{x.installed.dispose();}
  }));
  await check('a real hello cannot move a known binding without an advanced settled epoch, even with null cache authority',()=>classic(async f=>{
    f.scope.primarySessionWitnessEpoch=-1;await send(f.spec,'hello',{sessionId:'A'});assert.equal(f.guard.ready(world,'A'),true);
    f.native('B');assert.equal((await send(f.spec,'hello',{sessionId:'B'})).code,'stale_runtime');assert.equal(f.guard.ready(world,'B'),false);
  }));
  await check('a current-epoch known Classic native cannot be erased as if it were a lagging cache',()=>classic(async f=>{
    await send(f.spec,'hello',{sessionId:'A'});f.rpc.send({type:'switch_session'});f.native('B');f.mutation(true);
    f.scope.primarySessionWitnessEpoch=f.rpc.providerSessionEpoch();assert.equal((await send(f.spec,'hello',{sessionId:'B'})).code,'stale_runtime');
    assert.equal(f.guard.ready(world,'B'),false);
  }));
  await check('same-native unknown mutation cannot obtain the rejected-mutation revalidation exception',()=>classic(async f=>{
    await send(f.spec,'hello',{sessionId:'A'});const old=await f.guard.assertReady();
    assert.equal(await f.rpc.request({type:'switch_session'},{timeoutMs:5}),null);
    await assert.rejects(()=>f.guard.assertReady(),error=>error.code==='stale_runtime');assert.equal(old(),false);
    assert.equal((await send(f.spec,'begin',{sessionId:'A',callId:'unknown',toolCallId:'unknown',readOnly:false})).ok,false);
    assert.equal(f.rpc.providerSessionChanging(),true);
  }));
  for(const field of ['child','generation','cwd','source','stop'])await check('new epoch cannot revalidate across awaited '+field+' drift',()=>classic(async f=>{
    await send(f.spec,'hello',{sessionId:'A'});const proof=await f.guard.assertReady();f.rpc.send({type:'switch_session'});f.mutation(false);
    f.hold();const pending=f.guard.assertReady();await until(()=>f.waiting());
    if(field==='child')f.child().pid++;
    if(field==='generation')f.identity.runtimeGeneration='replacement';
    if(field==='cwd')f.cwd(pkg);
    if(field==='source')f.source('replacement');
    if(field==='stop'){f.guard.pause();assert.equal(f.guard.resume(),false);}
    f.release();await assert.rejects(()=>pending);assert.equal(proof(),false);assert.equal(f.guard.ready(),false);
  }));
  await check('Stop during a transition retry is terminal for that initialization, never a new budget',()=>classic(async f=>{
    let hints=0;const x=classicExtension(f,()=>{if(++hints===1){f.guard.pause();f.mutation(true);}});
    try{x.start('A');await f.guard.assertReady();await until(()=>x.installed.status().verified);f.rpc.send({type:'switch_session'});f.native('B');
      const before=x.hellos();x.start('B');await until(()=>x.installed.status().failed);assert.equal(x.hellos()-before,2);
      assert.equal(x.helloCodes.at(-1),'stale_runtime');await assert.rejects(()=>x.call('stopped'));assert.equal(x.hellos()-before,2);assert.equal(f.guard.resume(),false);
    }finally{x.installed.dispose();}
  }));
  await check('active old writer forbids transition hints/rebinding and stays held until its own end',()=>classic(async f=>fixture({readState:async()=>({sessionId:'native-B5'})},async(b,sb)=>{
    await send(f.spec,'hello',{sessionId:'A'});await send(sb,'hello',{sessionId:'native-B5'});
    await send(f.spec,'begin',{sessionId:'A',callId:'active-native-A',toolCallId:'same',readOnly:false});
    f.rpc.send({type:'switch_session'});f.native('B');const early=await send(f.spec,'hello',{sessionId:'B'});
    assert.equal(early.code,'stale_runtime');f.mutation(true);assert.equal((await send(f.spec,'hello',{sessionId:'B'})).code,'stale_runtime');
    let done=false;const next=send(sb,'begin',{sessionId:'native-B5',callId:'waiting-B5',toolCallId:'same',readOnly:false}).then(v=>{done=true;return v;});
    await wait(20);assert.equal(done,false);assert.equal(scheduler.busy(),true);f.guard.invalidate();await wait(10);assert.equal(done,false);
    assert.equal((await send(f.spec,'end',{sessionId:'A',callId:'active-native-A'})).ok,true);assert.equal((await next).ok,true);
    await send(sb,'end',{sessionId:'native-B5',callId:'waiting-B5'});
  })));
  console.log(`Session tool bridge: ${passed}/${passed}`);
 }finally{await a.dispose();await b.dispose();a.confirmCleanup();b.confirmCleanup();scheduler.dispose();fs.rmSync(world,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
