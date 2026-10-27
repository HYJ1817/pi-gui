/* Opt-in packaged-artifact probe for Z4-2, run by the maintainer after
 * `npm run build:app -- --rebuild`, which also rebuilds the standalone SEA in
 * build/. It only verifies the two repository build products (App 内嵌后端 via
 * ELECTRON_RUN_AS_NODE, and the standalone SEA); it never launches an installer,
 * touches an installed copy or claims full desktop-UI coverage. Offline by
 * construction: no renderer UI, PI_BIN points at a missing shim and only one
 * ephemeral loopback port opens. Not part of the npm test chain. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),{spawn}=require('node:child_process'),{once}=require('node:events'),{randomUUID,createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),digest=b=>createHash('sha256').update(b).digest('hex');
const RESOURCES=['collab-canvas.js','collab-proposal.js','collab-panel.js','collab-selection.js','collab.css','collab-panel.css','app.js','index.html','api.js',
 'collab-export.js','collab-canvas-productivity.js','collab-auto-layout.js','collab-layout-preview.js','collab-productivity.css'];
const REQUEST_MS=15000,READY_MS=2000,READY_DEADLINE_MS=15000,STOP_MS=5000,wait=ms=>new Promise(r=>setTimeout(r,ms));
/* Resolves true when the promise settles, false after ms. The timer is always
 * cleared so an already-exited backend never keeps the loop alive for the rest. */
const bounded=(promise,ms)=>new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),ms);Promise.resolve(promise).then(()=>{clearTimeout(timer);resolve(true)},()=>{clearTimeout(timer);resolve(true)})});
/* Signal covers the whole request including body reads; nothing waits forever. */
const request=(url,options={})=>fetch(url,{...options,signal:AbortSignal.timeout(REQUEST_MS)});
let checks=0;const rows=[],forms={};
const check=(name,ok)=>{assert(ok,name);checks++;rows.push(name);console.log('ok '+name)};
const manifestVersion=appRoot=>{try{return JSON.parse(fs.readFileSync(path.join(appRoot,'resources','app','package.json'),'utf8')).version||'unknown'}catch{return 'unknown'}};
(async()=>{
let world=null,launchFailure=null;
const output=process.env.Z4_PACKAGED_OUTPUT||path.join(os.tmpdir(),'pi-gui-z4-packaged-results.json');
/* Evidence JSON never records tokens, raw HTTP payloads, local paths or raw
 * error messages — only check labels and bounded codes. */
const finish=payload=>{try{fs.writeFileSync(output,JSON.stringify(payload,null,2));return true}catch(error){console.error('results JSON not written: '+error.code);return false}};
const cleanup=()=>{if(!world)return;const rel=path.relative(os.tmpdir(),fs.realpathSync(world));assert(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));fs.rmSync(world,{recursive:true,force:true})};
/* Bounded shutdown: TERM wait, then KILL wait; if the backend is still live the
 * child is unref'd and a fixed cleanup_timeout aborts any success reporting. */
const stopBackend=async(child,stopped)=>{
 if(child.exitCode===null&&!launchFailure)child.kill();
 if(await bounded(stopped,STOP_MS))return;
 if(child.exitCode===null&&!launchFailure)child.kill('SIGKILL');
 if(await bounded(stopped,STOP_MS))return;
 if(child.exitCode===null&&!launchFailure){child.unref();throw Object.assign(Error('cleanup_timeout'),{code:'cleanup_timeout'})}
};
try{
 world=fs.mkdtempSync(path.join(os.tmpdir(),'z4-packaged-'));
 const appRoot=path.join(root,'dist-app','Pi GUI-win32-x64'),appExe=path.join(appRoot,'Pi GUI.exe'),appServer=path.join(appRoot,'resources','app','server.cjs'),seaExe=path.join(root,'build','Pi GUI.exe');
 assert(fs.existsSync(appExe)&&fs.existsSync(appServer),'app build missing under dist-app: run npm run build:app -- --rebuild first');
 assert(fs.existsSync(seaExe),'SEA build missing under build: run npm run build:app -- --rebuild first');
 for(const form of ['app','sea']){
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const data=path.join(world,form);fs.mkdirSync(data);
  const token=randomUUID(),env={...process.env,PORT:String(port),PI_GUI_DATA:data,PI_GUI_OPEN:'0',PI_GUI_OFFLINE:'1',PI_OFFLINE:'1',PI_GUI_TOKEN:token,PI_CWD:'',PI_BIN:path.join(world,'missing-pi.cmd'),PI_CODING_AGENT_DIR:path.join(world,'agent')};
  if(form==='app')env.ELECTRON_RUN_AS_NODE='1';else delete env.ELECTRON_RUN_AS_NODE;
  launchFailure=null;
  const child=spawn(form==='app'?appExe:seaExe,form==='app'?[appServer]:[],{cwd:world,env,windowsHide:true,stdio:'ignore'});
  child.on('error',error=>{launchFailure=error.code||'launch-error'});
  /* Spawn failures emit 'error' without 'exit'; once(child,'exit') would reject
   * unhandled. Swallow that rejection here and fail via launchFailure instead. */
  const stopped=once(child,'exit').catch(()=>null);
  try{
   const base=`http://127.0.0.1:${port}`;let ready=false,backendVersion='unknown';const deadline=Date.now()+READY_DEADLINE_MS;
   for(;Date.now()<deadline;){try{const r=await fetch(base+'/api/health',{signal:AbortSignal.timeout(Math.max(1,Math.min(READY_MS,deadline-Date.now())))});if(r.ok){const health=await r.json();backendVersion=typeof health.version==='string'?health.version:'unknown';ready=health.app==='pi-gui';break}}catch{}if(child.exitCode!==null||launchFailure)break;await wait(50)}
   check(form+' live backend',ready);
   const digests={},endpoint=base+'/api/collab-documents',headers={'x-pi-gui-token':token,'content-type':'application/json'};
   check(form+' token authentication',(await request(endpoint,{method:'POST',body:'{"action":"open"}'})).status===401);
   check(form+' Origin precedes owner authority',(await request(endpoint,{method:'POST',headers:{...headers,origin:'http://example.invalid'},body:'{"action":"open"}'})).status===403);
   for(const file of RESOURCES){const r=await request(base+'/'+file,{headers});const bytes=Buffer.from(await r.arrayBuffer());digests[file]=digest(bytes);check(form+' exact resource '+file,r.ok&&digests[file]===digest(fs.readFileSync(path.join(root,'public',file))))}
   check(form+' POST-only route',(await request(endpoint,{headers})).status===405);
   const r=await request(endpoint,{method:'POST',headers,body:'{"action":"open"}'}),v=await r.json().catch(()=>({}));
   check(form+' trusted owner refusal',r.status===409&&v.code==='collab_scope_unavailable'&&v.ok===false);
   check(form+' refusal creates no document',!fs.existsSync(path.join(data,'collab-documents')));
   forms[form]={checks:rows.filter(n=>n.startsWith(form+' ')).length,backendVersion,manifestVersion:form==='app'?manifestVersion(appRoot):'unknown',resources:digests};
  }finally{
   await stopBackend(child,stopped);
   if(launchFailure)throw Error('packaged backend launch failed: '+launchFailure);
  }
 }
 cleanup();
 if(!finish({ok:true,checks,failed:0,forms,rows})){process.exitCode=1;return}
 console.log(`Z4 packaged: ${checks}/${checks}`)
}catch(error){
 /* A timed-out backend may still hold the temp world; leave it for the
  * maintainer instead of deleting files under a live process. */
 const timedOut=error?.code==='cleanup_timeout';
 if(!timedOut){try{cleanup()}catch{/* world is asserted to live under os.tmpdir() before removal */}}
 finish({ok:false,checks,failed:1,stage:timedOut?'cleanup_timeout':rows.length?rows[rows.length-1]:'setup',launchCode:launchFailure||null,rows});
 console.error(error);process.exitCode=1}
})()
