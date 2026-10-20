const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
test('real backend private IPC freezes HTTP mutations, releases, then exits normally',async t=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-backend-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const env={...process.env,PORT:String(port),PI_CWD:'',PI_GUI_DATA:data,PI_GUI_LOG_DIR:path.join(data,'logs'),PI_GUI_OPEN:'0',PI_OFFLINE:'1',PI_BIN:path.join(data,'nonexistent-pi'),PI_GUI_TOKEN:'fixture-token'};
  const child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);let id=0;
  async function action(action){return new Promise((resolve,reject)=>{
    const n=++id,timer=setTimeout(()=>reject(Error('IPC timeout '+output.slice(-1000))),20000);
    const listener=m=>{if(m?.type==='app-update'&&m.id===n){clearTimeout(timer);child.off('message',listener);resolve(m);}};
    child.on('message',listener);child.send({type:'app-update',id:n,action});
  });}
  const url=`http://127.0.0.1:${port}`;let ready=false;
  for(let i=0;i<100;i++){try{ready=(await fetch(url+'/api/health')).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(ready,true,output);
  assert.equal((await action('prepare')).ok,true);
  const response=await fetch(url+'/api/command',{method:'POST',headers:{'content-type':'application/json','X-Pi-Gui-Token':'fixture-token'},body:JSON.stringify({type:'prompt',message:'fixture never sent'})});
  assert.equal(response.status,503);assert.equal((await response.json()).code,'app_update_maintenance');
  assert.equal((await action('release')).ok,true);assert.equal((await action('prepare')).ok,true);
  const exited=new Promise(r=>child.once('exit',r));assert.equal((await action('shutdown')).ok,true);assert.equal(await exited,0);
});
