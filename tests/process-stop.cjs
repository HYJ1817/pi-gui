const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');let checks=0;
const equal=(a,b)=>{assert.equal(a,b);checks++;};const ok=v=>{assert.ok(v);checks++;};const same=(a,b)=>{assert.deepEqual(a,b);checks++;};
(async()=>{
  const {createRpcBridge}=await import('../server/rpc-bridge.js');let acknowledge,rejectAck,entered;let written=[];const started=new Promise(r=>entered=r);
  const bridge=createRpcBridge({runtime:{getCurrentCwd:()=>require('node:os').tmpdir(),isShuttingDown:()=>false},publish:()=>{},piBin:'fixture',isWin:false,env:{PI_GUI_PROCESS_TOKEN:'old-secret',PI_GUI_TOKEN:'gui-secret'},processLaunch:{available:()=>true,prepare:async()=>({args:['--extension','fixture-process'],env:{PI_GUI_PROCESS_TOKEN:'private-run'}}),invalidate:options=>{if(!options?.strict)return Promise.resolve();entered();return new Promise((resolve,reject)=>{acknowledge=resolve;rejectAck=reject;});}},spawnProcess:(command,args,opts)=>{
    equal(opts.env.PI_GUI_TOKEN,undefined);equal(opts.env.PI_GUI_PROCESS_TOKEN,'private-run');ok(args.includes('fixture-process'));
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdout.setEncoding=child.stderr.setEncoding=()=>{};child.stdin={on(){},end(){},write(line){const c=JSON.parse(line);written.push(c);if(c.id!==undefined)setImmediate(()=>child.stdout.emit('data',JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:{isStreaming:false,pendingMessageCount:0}})+'\n'));}};child.kill=()=>{};return child;
  }});
  try{
    await bridge.start();const first=bridge.abortAndWait({type:'abort'});await started;equal(written.length,0);ok(bridge.getState().stop.pending);acknowledge();const result=await first;ok(result.ok);same(written.map(c=>c.type),['clear_queue','abort']);
    const next=bridge.abortAndWait({type:'abort'});await new Promise(r=>setImmediate(r));rejectAck(Error('secret-raw-error'));const failure=await next;equal(failure.code,'process_cancel_unconfirmed');ok(!JSON.stringify(failure).includes('secret-raw-error'));await new Promise(r=>setTimeout(r,20));ok(written.some(c=>c.type==='abort'));
    console.log(`Process Stop: ${checks}/${checks}`);
  }finally{bridge.stop();}
})().catch(e=>{console.error(e);process.exitCode=1;});
