const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const {createHash}=require('node:crypto');
let checks = 0;
const ok = value => { assert.ok(value); checks++; };
async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!fn()) { if (Date.now() > end) throw Error('fixture_timeout'); await new Promise(r => setTimeout(r, 20)); }
}
(async () => {
  const { createPiSupervisor } = await import('../server/pi-supervisor.js');
  const { launchOwnedProcess } = await import('../server/process-runner.js');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'p32-pi-supervisor-'));
  const script = path.join(fixture, 'rpc.cjs');
  fs.writeFileSync(script, `const fs=require('node:fs'),{spawn}=require('node:child_process');
    const read=require('node:readline').createInterface({input:process.stdin});
    console.error('stderr-only');
    read.on('line',line=>{const m=JSON.parse(line);
      if(m.type==='tree')spawn(process.execPath,['-e',"const fs=require('fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),25)",m.file],{stdio:'ignore'});
      const leak=Object.keys(process.env).filter(k=>k.startsWith('PI_GUI_SUPERVISOR'));
      const wire=Buffer.from(JSON.stringify({id:m.id,unicode:'中文🙂',leak,...(m.type==='large'?{bytes:Buffer.byteLength(line),digest:require('node:crypto').createHash('sha256').update(line).digest('hex')}: {})})+'\\n');
      if(m.type==='split'){const p=wire.indexOf(Buffer.from('🙂'))+1;process.stdout.write(wire.subarray(0,p));setTimeout(()=>process.stdout.write(wire.subarray(p)),10);}
      else process.stdout.write(wire);
    });setInterval(()=>{},1000);`);
  const launches=[];
  const supervisor = createPiSupervisor({launch:(spec,opts)=>{launches.push(spec);return launchOwnedProcess(spec,opts);}});
  try {
    const opts = {cwd:fixture, env:{...process.env},shell:false};
    const a = supervisor.spawnProcess(process.execPath,[script],opts);
    const b = supervisor.spawnProcess(process.execPath,[script],opts);
    let outA='',errA='',outB='';
    a.stdout.on('data',c=>{outA+=c.toString();}); a.stderr.on('data',c=>{errA+=c.toString();});
    b.stdout.on('data',c=>{outB+=c.toString();});
    await Promise.all([once(a,'spawn'),once(b,'spawn')]);
    ok(a.pid === undefined && b.pid === undefined);
    a.stdin.write(JSON.stringify({id:'A'})+'\n'); b.stdin.write(JSON.stringify({id:'B'})+'\n');
    await until(()=>outA.includes('A')&&outB.includes('B'));
    ok(!outA.includes('B')&&!outB.includes('A'));
    ok(errA.includes('stderr-only')&&!outA.includes('stderr-only'));
    ok(JSON.parse(outA.trim()).unicode==='中文🙂');
    ok(JSON.parse(outA.trim()).leak.length===0);
    const largeLine=JSON.stringify({id:'large-input',type:'large',message:'中🙂'.repeat(350000),images:[{type:'image',data:Buffer.alloc(2*1024*1024,42).toString('base64'),mimeType:'image/png'}]});
    const expectedDigest=createHash('sha256').update(largeLine).digest('hex');
    await new Promise((resolve,reject)=>a.stdin.write(largeLine+'\n',e=>e?reject(e):resolve()));
    await until(()=>outA.includes('large-input'));const largeResult=outA.trim().split('\n').map(JSON.parse).find(m=>m.id==='large-input');
    ok(largeResult.bytes===Buffer.byteLength(largeLine)&&largeResult.digest===expectedDigest);
    const queued=supervisor.spawnProcess(process.execPath,[script],opts);let queuedOut='';queued.stdout.on('data',c=>{queuedOut+=c.toString();});
    queued.on('error',()=>{});const queuedWrite=new Promise((resolve,reject)=>queued.stdin.write(largeLine+'\n',e=>e?reject(e):resolve()));
    await queuedWrite;await until(()=>queuedOut.includes('large-input'));
    ok(JSON.parse(queuedOut.trim()).digest===expectedDigest);await supervisor.killProcessTree(queued);
    ok(!launches.some(v=>Object.keys(v.env).some(k=>k==='PI_GUI_TOKEN')));
    for(const token of ['wrong-token',launches[0].env.PI_GUI_SUPERVISOR_TOKEN]){
      const socket=net.connect({host:'127.0.0.1',port:Number(launches[0].env.PI_GUI_SUPERVISOR_PORT)});
      socket.on('error',()=>{});const closed=new Promise(r=>socket.once('close',r));
      socket.on('connect',()=>socket.write(JSON.stringify({type:'hello',token})+'\n'));await closed;ok(true);
    }
    await assert.rejects(supervisor.killProcessTree({pid:process.pid}),{code:'foreign_process'});ok(true);
    let split='';a.stdout.on('data',c=>{split+=c.toString();});
    a.stdin.write(JSON.stringify({id:'split',type:'split'})+'\n');await until(()=>split.includes('\n'));
    ok(JSON.parse(split.trim()).unicode==='中文🙂');
    const marker = path.join(fixture,'child-marker');
    a.stdin.write(JSON.stringify({id:'tree',type:'tree',file:marker})+'\n');
    await until(()=>fs.existsSync(marker)&&fs.statSync(marker).size>=3);
    const aClosed=once(a,'close'); await supervisor.killProcessTree(a); await aClosed;
    const content=fs.readFileSync(marker,'utf8'); await new Promise(r=>setTimeout(r,150));
    ok(fs.readFileSync(marker,'utf8')===content);
    ok(a.exitCode!==null && b.exitCode===null);
    b.stdin.write(JSON.stringify({id:'B-alive'})+'\n'); await until(()=>outB.includes('B-alive'));ok(true);
    await supervisor.killProcessTree(a);ok(true);
    const bClosed=once(b,'close');await supervisor.dispose();await bClosed;ok(b.exitCode!==null);
    const stale=supervisor.spawnProcess(process.execPath,[script],opts);let errorCode;
    stale.on('error',e=>{errorCode=e.code;});await new Promise(r=>stale.once('close',r));ok(errorCode==='supervisor_closed');
    const timeoutSupervisor=createPiSupervisor({connectTimeoutMs:20,launch:()=>{
      const guardian=new EventEmitter();guardian.stop=async()=>{guardian.emit('close',0);};return guardian;
    }});
    const noConnection=timeoutSupervisor.spawnProcess(process.execPath,[script],opts);let timeoutCode;
    noConnection.on('error',e=>{timeoutCode=e.code;});await new Promise(r=>noConnection.once('close',r));
    ok(timeoutCode==='pi_connect_timeout');await timeoutSupervisor.dispose();
    const invalidSupervisor=createPiSupervisor();
    const invalid=invalidSupervisor.spawnProcess('shell string',[],{...opts,shell:true});let invalidCode;
    invalid.on('error',e=>{invalidCode=e.code;});await new Promise(r=>invalid.once('close',r));ok(invalidCode==='pi_launch_invalid');await invalidSupervisor.dispose();
    const boundary=createPiSupervisor({inputLimit:4096});
    try{
      const bounded=boundary.spawnProcess(process.execPath,[script],opts);let boundedOut='';const inputErrors=[];
      bounded.stdout.on('data',c=>{boundedOut+=c.toString();});bounded.on('error',e=>inputErrors.push(e.code));
      const prefix=JSON.stringify({id:'boundary',type:'large',message:''});const exact=prefix.replace('"message":""','"message":"'+'x'.repeat(4096-Buffer.byteLength(prefix))+'"');
      ok(Buffer.byteLength(exact)===4096);
      await new Promise((resolve,reject)=>bounded.stdin.write(exact+'\n',e=>e?reject(e):resolve()));await until(()=>boundedOut.includes('boundary'));
      ok(JSON.parse(boundedOut.trim()).bytes===4096);
      const closing=new Promise(r=>bounded.once('close',r));let rejected;
      bounded.stdin.write(exact+'x\n',e=>{rejected=e?.code;});await closing;
      ok(rejected==='pi_input_limit'&&inputErrors.includes('pi_input_limit'));
    }finally{await boundary.dispose();}
    const pendingSupervisor=createPiSupervisor({inputLimit:4096,launch:()=>{const guardian=new EventEmitter();guardian.stop=async()=>{guardian.emit('close',0);};return guardian;}});
    try{
      const pending=pendingSupervisor.spawnProcess(process.execPath,[script],opts);pending.on('error',()=>{});let pendingError;
      const closing=new Promise(r=>pending.once('close',r));pending.stdin.write('x'.repeat(3000));
      pending.stdin.write('y'.repeat(2000),e=>{pendingError=e?.code;});await closing;ok(pendingError==='pi_input_limit');
    }finally{await pendingSupervisor.dispose();}
    console.log(`Pi supervisor real ${process.platform} RPC/tree: ${checks}/${checks}`);
  } finally {await supervisor.dispose();fs.rmSync(fixture,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
