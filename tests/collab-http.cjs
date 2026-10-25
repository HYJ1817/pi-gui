const baseAssert = require('node:assert/strict');
let assertions = 0;
const assert = new Proxy(baseAssert, {
  apply(target, receiver, args) { assertions++; return Reflect.apply(target, receiver, args); },
  get(target, key) { const value = target[key]; return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value; },
});
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
let checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log('ok '+name);};
(async()=>{
  const {createCollabRoutes}=await import('../server/collab-routes.js');
  const {createCollabService}=await import('../server/collab-service.js');
  const {createCollabStore}=await import('../server/collab-store.js');
  const {createAuth}=await import('../server/auth.js');
  const {createRouter}=await import('../server/router.js');
  const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-gui-collab-http-'));
  const data=path.join(world,'data'),project=path.join(world,'project');fs.mkdirSync(data);fs.mkdirSync(project);
  let token='token-a',owner='owner-a';
  const scope={key:'a'.repeat(64),token:'b'.repeat(64),sessionId:'c'.repeat(64),projectRoot:project,workspaceCwd:project,gitCommon:path.join(project,'.git'),assertCurrent(){}};
  const store=createCollabStore({dataDir:data});
  const service=createCollabService({store});
  const withAuthority=async(req,fn)=>{
    if(req.headers['x-pi-gui-owner']!==owner)throw Object.assign(Error('private C:/sensitive'),{code:'collab_scope_unavailable'});
    return fn(scope);
  };
  const routes=createCollabRoutes({service,withAuthority});
  let auth;
  const server=http.createServer(createRouter({
    auth:{denyRequest:req=>auth.denyRequest(req)},collabDocuments:routes,
    requireLegacyScope:()=>true,legacyScope:()=>({classic:'deliberately-different'}),
  }));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port,origin='http://127.0.0.1:'+port;
  auth=createAuth({token,port,appId:'pi-gui',protocol:1,version:'fixture'});
  const headers=()=>({'Content-Type':'application/json','X-Pi-Gui-Token':token,'X-Pi-Gui-Owner':owner,Origin:origin});
  const send=async(body,extra={})=>{const r=await fetch(origin+'/api/collab-documents'+(extra.search||''),{method:extra.method||'POST',headers:extra.headers||headers(),body:extra.method==='GET'?undefined:extra.raw??JSON.stringify(body)});const text=await r.text();let result;try{result=JSON.parse(text);}catch{result={ok:false,code:'not-json'};}return {status:r.status,...result};};
  let current;
  try{
    await check('Origin and Token protect all new actions',async()=>{
      assert.equal((await send({action:'open'},{headers:{...headers(),Origin:'https://evil.invalid'}})).status,403);
      assert.equal((await send({action:'open'},{headers:{...headers(),'X-Pi-Gui-Token':'wrong'}})).status,401);
      assert.equal(fs.existsSync(path.join(data,'collab-documents')),false);
    });
    await check('POST-only bounded strict request envelope',async()=>{
      assert.equal((await send(null,{method:'GET'})).status,405);assert.equal((await send({action:'open'},{search:'?path=escape'})).status,400);
      assert.equal((await send(null,{raw:'{broken'})).status,400);assert.equal((await send(null,{raw:' '.repeat(65537)})).status,413);
      assert.equal((await send({action:'open',path:'../escape'})).status,400);
    });
    await check('open no-write then explicit create with real atomic store',async()=>{
      current=await send({action:'open'});assert.equal(current.ok,true);assert.equal(current.document,null);assert.equal(fs.existsSync(path.join(data,'collab-documents')),false);
      current=await send({action:'create',editorId:current.editorId,expectedRevision:null});assert.equal(current.ok,true);assert.equal(current.document.graph.nodes.length,3);assert.equal(store.read(scope).doc.revision,1);
    });
    await check('controlled edit persists and raw snapshot replacement is refused',async()=>{
      const ops=[{opId:'u1',actor:'user',type:'node.update',baseRevision:1,params:{id:'n1',label:'HTTP文字'}}];
      current=await send({action:'operations',editorId:current.editorId,expectedRevision:1,ops});assert.equal(current.ok,true);assert.equal(store.read(scope).doc.graph.nodes[0].label,'HTTP文字');
      assert.equal((await send({action:'operations',editorId:current.editorId,expectedRevision:2,ops,document:current.document})).status,400);
    });
    await check('old revision and owner reject while original bytes remain',async()=>{
      const file=path.join(data,'collab-documents',scope.key+'.json'),before=fs.readFileSync(file);
      const stale=await send({action:'undo',editorId:current.editorId,expectedRevision:1});assert.equal(stale.status,409);
      owner='owner-b';const old=await send({action:'open'},{headers:{...headers(),'X-Pi-Gui-Owner':'owner-a'}});assert.equal(old.code,'collab_scope_unavailable');
      assert.equal(JSON.stringify(old).includes('sensitive'),false);assert.deepEqual(fs.readFileSync(file),before);
    });
    await check('production cannot invent Agent source through request JSON',async()=>{
      const open=await send({action:'open'});assert.equal(open.proposalSourceAvailable,false);
      const p=await send({action:'accept',editorId:open.editorId,expectedRevision:2,proposalId:'fake'});assert.equal(p.code,'collab_proposal_unavailable');
      assert.equal((await send({action:'proposal',actor:'agent',sessionId:scope.sessionId,ops:[]})).status,400);
    });
    await check('damaged persisted file is preserved on read and subsequent request',async()=>{
      const file=path.join(data,'collab-documents',scope.key+'.json');fs.writeFileSync(file,'{damaged');const bytes=fs.readFileSync(file);
      const result=await send({action:'open'});assert.equal(result.code,'collab_storage_corrupt');assert.equal(result.status,409);assert.deepEqual(fs.readFileSync(file),bytes);
      assert.equal(JSON.stringify(result).includes(world),false);
    });
  } finally {await new Promise(r=>server.close(r));fs.rmSync(world,{recursive:true,force:true});}
  console.log(`Collab HTTP: ${checks}/${checks}; assertions=${assertions}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
