const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let passed=0;async function check(name,run){await run();passed++;console.log('PASS '+name);}
(async()=>{
 let createSessionToolBridge;try{({createSessionToolBridge}=await import('../server/session-tool-bridge.js'));}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
 assert.equal(typeof createSessionToolBridge,'function','private per-launch tool guard is required');
 const {createSessionToolScheduler}=await import('../server/session-tool-scheduler.js');
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-tool-private-')),scheduler=createSessionToolScheduler();let native='native-A';
 const a=createSessionToolBridge({scheduler,launch:{},getCwd:()=>world,readState:async()=>({sessionId:native}),supported:true});
 const b=createSessionToolBridge({scheduler,launch:{},getCwd:()=>world,readState:async()=>({sessionId:'native-B'}),supported:true});
 const send=async(spec,action,body={},token=spec.env.PI_GUI_TOOL_TOKEN,origin)=>{
  const response=await fetch(spec.env.PI_GUI_TOOL_URL+'/'+action,{method:'POST',headers:{'content-type':'application/json','x-pi-gui-tool-token':token,...(origin?{origin}:{})},body:JSON.stringify(body)});return {status:response.status,...await response.json()};};
 try{
  const sa=await a.prepare(),sb=await b.prepare();
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
  console.log(`Session tool bridge: ${passed}/${passed}`);
 }finally{await a.dispose();await b.dispose();a.confirmCleanup();b.confirmCleanup();scheduler.dispose();fs.rmSync(world,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
