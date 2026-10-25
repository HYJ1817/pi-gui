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
    await check('generate routes Classic-only capture readiness; Runtime requests bypass it',async()=>{
      // 独立小路由：spy 记录 beforeAuthority 调用；Classic 模式下抛错模拟 capture 未就绪。
      let classicReadyCalls=0,classicReadyBroken=false,generated=[];
      const proposalsStub={beginGeneration:async call=>{generated.push(call);return {ok:true,attemptId:'ga-fixture'};},
        generationStatus:()=>({state:'idle'}),head:()=>null,get:()=>null,settle:()=>{}};
      // 独立数据目录：外层检查会故意损坏共享 store 的文档，这里必须隔离。
      const data2=path.join(world,'data-2');fs.mkdirSync(data2);
      const store2=createCollabStore({dataDir:data2});
      const svc2=createCollabService({store:store2,proposals:proposalsStub});
      let auth2=null;
      const runtimeScope={...scope,origin:'runtime',conversationId:'conv-fixture',
        key:'e'.repeat(64),token:'f'.repeat(64),sessionId:'9'.repeat(64)};
      const seenScopes=[];
      const routes2=createCollabRoutes({service:svc2,
        withAuthority:async(req,fn)=>{
          if(req.headers['x-pi-gui-conversation']!==undefined)return fn(runtimeScope);
          return fn(scope);
        },
        beforeAuthority:async(request,req)=>{
          if(request?.action!=='generate')return;
          if(req?.headers?.['x-pi-gui-conversation']!==undefined)return;
          classicReadyCalls++;
          if(classicReadyBroken)throw Object.assign(Error('capture not ready'),{code:'collab_generate_unavailable'});
        }});
      const server2=http.createServer(createRouter({
        auth:{denyRequest:req=>auth2.denyRequest(req)},collabDocuments:routes2,
        requireLegacyScope:()=>true,legacyScope:()=>({classic:'deliberately-different'})}));
      await new Promise(r=>server2.listen(0,'127.0.0.1',r));
      try{
        const p2=server2.address().port,o2='http://127.0.0.1:'+p2;
        auth2=createAuth({token,port:p2,appId:'pi-gui',protocol:1,version:'fixture'});
        const h2=(extra={})=>({'Content-Type':'application/json','X-Pi-Gui-Token':token,'X-Pi-Gui-Owner':'owner-a',Origin:o2,...extra});
        const post=async(body,extra={})=>{const r=await fetch(o2+'/api/collab-documents',{method:'POST',headers:h2(extra.headers),body:JSON.stringify(body)});return {status:r.status,...await r.json()};};
        // Classic 生成：capture 就绪检查被调用
        let open2=await post({action:'open'});
        const created2=await post({action:'create',editorId:open2.editorId,expectedRevision:null});
        assert.equal(created2.ok,true);
        const classicGen=await post({action:'generate',editorId:created2.editorId,expectedRevision:1,instruction:'classic 生成'});
        assert.equal(classicGen.ok,true);assert.equal(classicReadyCalls,1);
        // Runtime 生成（带会话头）：不调用 Classic capture 检查
        const runtimeOpen=await post({action:'open'},{headers:{'X-Pi-Gui-Conversation':'conv-fixture'}});
        const runtimeCreated=await post({action:'create',editorId:runtimeOpen.editorId,expectedRevision:null},{headers:{'X-Pi-Gui-Conversation':'conv-fixture'}});
        assert.equal(runtimeCreated.ok,true);
        const runtimeGen=await post({action:'generate',editorId:runtimeCreated.editorId,expectedRevision:1,instruction:'runtime 生成'},{headers:{'X-Pi-Gui-Conversation':'conv-fixture'}});
        assert.equal(runtimeGen.ok,true,'Runtime 生成不得依赖 Classic capture 就绪');
        assert.equal(classicReadyCalls,1,'Runtime 请求不触发 Classic 就绪检查');
        assert.equal(generated.length,2);
        assert.equal(generated[1].scope.origin,'runtime');
        assert.equal(generated[1].scope.conversationId,'conv-fixture');
        // Classic capture 故障时：Classic 生成被拒，Runtime 生成不受影响
        classicReadyBroken=true;
        const classicBlocked=await post({action:'generate',editorId:created2.editorId,expectedRevision:1,instruction:'再试'});
        assert.equal(classicBlocked.ok,false);
        assert.equal(classicBlocked.code,'collab_generate_unavailable');
        const runtimeStill=await post({action:'generate',editorId:runtimeCreated.editorId,expectedRevision:1,instruction:'runtime 再试'},{headers:{'X-Pi-Gui-Conversation':'conv-fixture'}});
        assert.equal(runtimeStill.ok,true,'Classic 未就绪不得阻塞 Runtime 合法生成');
        assert.equal(classicReadyCalls,2);
      }finally{await new Promise(r=>server2.close(r));}
    });
  } finally {await new Promise(r=>server.close(r));fs.rmSync(world,{recursive:true,force:true});}
  console.log(`Collab HTTP: ${checks}/${checks}; assertions=${assertions}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
