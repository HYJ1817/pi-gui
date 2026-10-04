const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const http=require('node:http');
const {createBrowserAgentBridge}=require('../electron/browser-agent-bridge.cjs');
(async()=>{
  let calls=0, invalidations=0, enabled=false;
  const agent={status:()=>({generation:1}),invalidate:()=>invalidations++,setEnabled:value=>{enabled=value;},execute:async(req,{signal})=>{calls++;if(req.args.url==='http://localhost/wait')await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error(),{code:'cancelled'})),{once:true}));return {ok:true};}};
  const bridge=createBrowserAgentBridge({agent,timeoutMs:40,bodyTimeoutMs:120,maxPayloadBytes:256});await bridge.start();
  const master=bridge.connection();
  async function call(endpoint,body={},token=master.token,headers={}) { const response=await fetch(master.url+endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Pi-Browser-Token':token,...headers},body:JSON.stringify({requestId:randomUUID(),...body})});return {status:response.status,...await response.json()}; }
  function slow(endpoint,token,body){let req;const result=new Promise((resolve,reject)=>{req=http.request(master.url+endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Pi-Browser-Token':token}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode,...JSON.parse(text)});}catch(err){reject(err);}});});req.on('error',reject);req.write(body.slice(0,10));});return {result,finish:()=>req.end(body.slice(10))};}
  try{
    assert.equal((await call('/session',{},'wrong')).status,403);
    assert.equal((await call('/session',{},master.token,{Origin:'http://localhost'})).status,403);
    const first=await call('/session');assert.notEqual(first.token,master.token);assert.equal(first.token.length,64);assert.equal(enabled,false);
    const token=first.token;
    assert.equal((await call('/session',{},token)).status,403);
    const state=await call('/state',{},token);assert.equal(state.generation,1);
    const action={action:'status',args:{},generation:1,epoch:state.epoch};
    assert.equal((await call('/action',action,token)).ok,true);assert.equal(calls,1);
    assert.equal((await call('/action',{...action,action:'eval'},token)).code,'unknown_action');
    assert.equal((await call('/action',{...action,args:{script:'secret'}},token)).code,'invalid_request');
    assert.equal((await call('/action',{...action,generation:0},token)).code,'stale_browser_generation');
    const id=randomUUID();assert.equal((await call('/action',{...action,requestId:id},token)).ok,true);assert.equal((await call('/action',{...action,requestId:id},token)).code,'busy');
    assert.equal((await call('/action',{...action,action:'open',args:{url:'http://localhost/wait'}},token)).code,'timeout');
    assert.equal((await call('/action',{...action,args:{extra:'a'.repeat(400)}},token)).status,413);
    const cancelledId=randomUUID();await call('/cancel',{requestId:cancelledId},token);
    assert.equal((await call('/action',{...action,requestId:cancelledId},token)).code,'cancelled');
    const waiting=call('/action',{...action,action:'open',args:{url:'http://localhost/wait'}},token);
    await new Promise(resolve=>setTimeout(resolve,5));
    const queued=call('/action',action,token);
    await call('/invalidate');
    assert.equal((await waiting).code,'cancelled');assert.equal((await queued).code,'cancelled');
    await call('/invalidate');assert.equal((await call('/action',action,token)).code,'cancelled');
    const oldSlow=slow('/state',token,JSON.stringify({requestId:randomUUID()}));await new Promise(resolve=>setTimeout(resolve,5));
    const next=await call('/session');oldSlow.finish();assert.equal((await oldSlow.result).status,403);
    assert.notEqual(next.token,token);assert.equal((await call('/state',{},token)).status,403);assert.ok(invalidations>=3);
    const deadline=slow('/state',next.token,JSON.stringify({requestId:randomUUID()}));assert.equal((await deadline.result).code,'timeout');
    console.log('gui-browser-bridge: 25/25 assertions passed');
  }finally{await bridge.stop();}
})().catch(error=>{console.error(error);process.exitCode=1;});
