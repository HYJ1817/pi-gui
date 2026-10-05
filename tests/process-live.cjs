// Opt-in: actual local dev services in temporary workspaces, no installs/network.
if(process.env.PI_GUI_PROCESS_LIVE!=='1'){console.log('Opt in: PI_GUI_PROCESS_LIVE=1 npm run test:process-live');process.exit(0);}
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),http=require('node:http'),{spawn}=require('node:child_process');
let checks=0;function ok(v,label){assert.ok(v,label);checks++;console.log('PASS '+label);}
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
async function until(fn,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('timeout');}
(async()=>{
  const {createManagedProcesses,probeReady}=await import('../server/managed-processes.js');
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'p31-live-'));const m=createManagedProcesses({context:()=>({cwd,workspace:1,run:1})});const g=m.snapshot().generation;m.enable(true,g);
  const start=async spec=>{const initial=await m.action('start',spec,g);ok(initial.process.state==='starting','initial starting');const id=initial.process.id;const r=await m.action('status',{id,revision:1,waitReady:true},g);ok(r.process.ready,'ready evidence');return r.process;};
  const stop=async p=>{const s=await m.action('stop',{id:p.id,revision:p.revision},g);ok(s.process.state==='exited','confirmed tree stop');};
  try{
    const vite=process.env.P31_VITE_CLI;if(!vite||!fs.existsSync(vite))throw Error('Set P31_VITE_CLI to an existing installation; no automatic install.');
    const vp=await port();fs.writeFileSync(path.join(cwd,'index.html'),'<h1>Vite P31</h1><script type="module" src="/main.js"></script>');fs.writeFileSync(path.join(cwd,'main.js'),'document.querySelector("h1").textContent="first";');
    fs.writeFileSync(path.join(cwd,'package.json'),JSON.stringify({private:true,scripts:{dev:`node "${vite.replace(/\\/g,'/')}" --host 127.0.0.1 --port ${vp} --strictPort`}}));
    let p=await start({command:'npm',args:['run','dev'],ready:{type:'http',url:`http://127.0.0.1:${vp}/`,timeoutMs:30000}});
    const first=await fetch(p.endpoint+'main.js').then(r=>r.text());ok(first.includes('first'),'Vite serves first source');
    fs.writeFileSync(path.join(cwd,'main.js'),'document.querySelector("h1").textContent="second";');await until(async()=> (await fetch(p.endpoint+'main.js').then(r=>r.text())).includes('second'));ok(true,'Vite serves modified source');
    p=(await m.action('restart',{id:p.id,revision:p.revision},g)).process;p=(await m.action('status',{id:p.id,revision:p.revision,waitReady:true},g)).process;ok(p.ready&&p.revision===2,'Vite restart same spec and new revision');await stop(p);ok(!await probeReady({type:'tcp',host:'127.0.0.1',port:vp}),'Vite port released');
    const pp=await port();fs.writeFileSync(path.join(cwd,'index.html'),'<h1>Python P31</h1>');
    p=await start({command:process.env.P31_PYTHON||'python',args:['-u','-m','http.server',String(pp),'--bind','127.0.0.1'],ready:{type:'tcp',host:'127.0.0.1',port:pp,timeoutMs:30000}});ok((await fetch(p.endpoint).then(r=>r.text())).includes('Python P31'),'real Python HTTP');await stop(p);ok(!await probeReady({type:'tcp',host:'127.0.0.1',port:pp}),'Python port released');
    const occupied=http.createServer((_,res)=>res.end('owned fixture'));await new Promise(r=>occupied.listen(0,'127.0.0.1',r));const op=occupied.address().port;
    try{await assert.rejects(m.action('start',{command:'node',args:[],ready:{type:'tcp',port:op}},g),/port_in_use/);checks++;ok((await fetch(`http://127.0.0.1:${op}`).then(r=>r.text()))==='owned fixture','foreign port service survives');}finally{await new Promise(r=>occupied.close(r));}
    p=(await m.action('start',{command:'p31-nonexistent-executable',args:[]},g)).process;ok(p.state==='failed'&&p.code==='spawn_failed','spawn failure bounded');
    p=(await m.action('start',{command:process.execPath,args:['-e','setInterval(()=>{},1000)'],ready:{type:'log',marker:'NEVER',timeoutMs:1500}},g)).process;p=(await m.action('status',{id:p.id,revision:1,waitReady:true},g)).process;ok(p.state==='failed'&&p.code==='ready_timeout','ready timeout cleans tree');
    p=(await m.action('start',{command:process.execPath,args:['-e','process.exit(7)'],ready:{type:'log',marker:'NEVER',timeoutMs:10000}},g)).process;p=(await m.action('status',{id:p.id,revision:1,waitReady:true},g)).process;ok(p.state==='failed','child crash');
    // Parent exits while its child keeps serving: guardian must clean the descendant.
    const tp=await port();fs.writeFileSync(path.join(cwd,'tree.cjs'),`require('node:child_process').spawn(process.execPath,['-e',"require('node:http').createServer((q,s)=>s.end('tree')).listen(${tp},'127.0.0.1')"],{stdio:'ignore'});console.log('TREE_READY');setTimeout(()=>process.exit(0),2500);`);
    p=await start({command:process.execPath,args:['tree.cjs'],ready:{type:'tcp',port:tp,timeoutMs:15000}});await until(()=>m.snapshot().processes.find(x=>x.id===p.id).state==='exited');ok(!await probeReady({type:'tcp',host:'127.0.0.1',port:tp}),'descendant cleaned after primary exit');
    p=await start({command:process.execPath,args:['-e','console.log("READY");for(let i=0;i<5000;i++)console.log("line "+i);console.log("Authorization: Bearer private");setInterval(()=>{},1000)'],ready:{type:'log',marker:'READY',timeoutMs:15000}});await until(async()=> (await m.action('logs',{id:p.id,revision:1,cursor:0,limit:256},g)).truncated);const logs=await m.action('logs',{id:p.id,revision:1,cursor:0,limit:256},g);ok(logs.lines.length<=256&&!JSON.stringify(logs).includes('private'),'real flood ring and redaction');await stop(p);
    p=await start({command:process.execPath,args:['-e','console.log("READY");setInterval(()=>{},1000)'],ready:{type:'log',marker:'READY',timeoutMs:15000}});await m.dispose();ok(m.snapshot().processes.every(x=>!['ready','running','starting','stopping'].includes(x.state)),'app lifecycle cleanup');
    const ep=await port();fs.writeFileSync(path.join(cwd,'exit-tree.cjs'),`require('node:child_process').spawn(process.execPath,['-e',"require('node:http').createServer((q,s)=>s.end('owned-exit-tree')).listen(${ep},'127.0.0.1')"],{stdio:'ignore'});setInterval(()=>{},1000);`);
    const worker=spawn(process.execPath,[path.join(__dirname,'process-exit-worker.cjs'),cwd,String(ep)],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    try{
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('exit fixture startup timeout')),20000);worker.stdout.on('data',chunk=>{if(chunk.toString().includes('OWNED_READY')){clearTimeout(timer);resolve();}});worker.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(Error('exit fixture failed'));});worker.once('error',reject);});
      ok((await fetch(`http://127.0.0.1:${ep}/`).then(r=>r.text()))==='owned-exit-tree','abrupt exit fixture descendant ownership');worker.stdin.end();
      await new Promise(r=>worker.once('close',r));await until(async()=>!await probeReady({type:'tcp',host:'127.0.0.1',port:ep}));ok(true,'backend abrupt exit closes guardian tree');
    }finally{worker.stdin.end();}
    console.log(`Process live ${process.platform}: ${checks}/${checks}`);
  }finally{await m.dispose();fs.rmSync(cwd,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
