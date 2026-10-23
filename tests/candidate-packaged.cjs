/* Opt-in after build:app -- --rebuild. No project, model or real account. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),{spawn}=require('node:child_process'),{once}=require('node:events'),{randomUUID,createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),digest=b=>createHash('sha256').update(b).digest('hex');let checks=0;
const check=(name,condition)=>{assert(condition,name);checks++;console.log('ok '+name);};
(async()=>{
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'t4b-packaged-'));
 try{for(const form of ['app','sea']){
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const appRoot=path.join(root,'dist-app/Pi GUI-win32-x64'),data=path.join(world,form);fs.mkdirSync(data);
  const token=randomUUID(),env={...process.env,PORT:String(port),PI_GUI_DATA:data,PI_GUI_OPEN:'0',PI_GUI_TOKEN:token,PI_CWD:'',PI_BIN:path.join(world,'missing-pi.cmd'),PI_CODING_AGENT_DIR:path.join(world,'agent')};
  if(form==='app')env.ELECTRON_RUN_AS_NODE='1';else delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(form==='app'?path.join(appRoot,'Pi GUI.exe'):path.join(root,'build/Pi GUI.exe'),form==='app'?[path.join(appRoot,'resources/app/server.cjs')]:[],{cwd:world,env,windowsHide:true,stdio:'ignore'}),exit=once(child,'exit');
  try{const base=`http://127.0.0.1:${port}`;let ready=false;for(let i=0;i<300;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,50));}check(form+' owns live backend',ready);
   check(form+' candidate API retains authentication',(await fetch(base+'/api/candidate-runs')).status===401);
   const headers={'x-pi-gui-token':token};
   for(const file of ['candidate-review.js','review-task-preview.js','api.js','html-escape.js','diff.js','util.js','styles.css']){
    const response=await fetch(base+'/'+file,{headers});check(form+' '+file+' matches source',response.ok&&digest(Buffer.from(await response.arrayBuffer()))===digest(fs.readFileSync(path.join(root,'public',file))));
   }
   const response=await fetch(base+'/api/candidate-runs',{headers}),value=await response.json();check(form+' missing source authority refuses without execution',response.status===409&&value.ok===false&&!fs.existsSync(path.join(data,'worktrees')));
  }finally{if(child.exitCode===null)child.kill();await exit;}
 }
 check('packaged native tool guard matches source',digest(fs.readFileSync(path.join(root,'dist-app/Pi GUI-win32-x64/resources/app/extensions/pi-gui-tool-guard/index.js')))===digest(fs.readFileSync(path.join(root,'extensions/pi-gui-tool-guard/index.js'))));
 }finally{const relative=path.relative(os.tmpdir(),fs.realpathSync(world));assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(world,{recursive:true,force:true});}
 console.log(`Candidate packaged: ${checks}/${checks}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
