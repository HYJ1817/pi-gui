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
  console.log(`Session tool bridge: ${passed}/${passed}`);
 }finally{await a.dispose();await b.dispose();a.confirmCleanup();b.confirmCleanup();scheduler.dispose();fs.rmSync(world,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
