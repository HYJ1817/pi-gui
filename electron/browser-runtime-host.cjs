'use strict';
const http=require('node:http');
const {randomUUID,timingSafeEqual}=require('node:crypto');
const {createBrowserAgent}=require('./browser-agent.cjs');
const {createBrowserAgentBridge}=require('./browser-agent-bridge.cjs');
const FIELDS=['backendInstance','runtimeId','runtimeGeneration','projectId','workspaceId','workspaceEpoch','conversationId'];
const OPTIONAL=['sessionId'];
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function scopeKey(scope){
  if(!scope||Array.isArray(scope)||typeof scope!=='object'||Object.keys(scope).some(k=>!FIELDS.includes(k)&&!OPTIONAL.includes(k)))throw Error('invalid_scope');
  if(FIELDS.some(k=>typeof scope[k]!=='string'||scope[k].length<1||scope[k].length>128))throw Error('invalid_scope');
  if(scope.sessionId!=null&&(typeof scope.sessionId!=='string'||scope.sessionId.length>128))throw Error('invalid_scope');
  return JSON.stringify(FIELDS.map(k=>scope[k]));
}
/** Private backend lifecycle gateway. Each owner gets its own existing Browser bridge. */
function createRuntimeBrowserHost({origin,getWindow,ipcMain,extensionPath,
  createController=options=>require('./browser-view.cjs').createBrowserController(options),
  createAgent=createBrowserAgent,createBridge=createBrowserAgentBridge,onFocus=()=>{}}){
  const token=randomUUID(),records=new Map(),retired=new Set();let focused=null,server=null,url='',disposed=false,chain=Promise.resolve(),stopPromise=null;
  const send=(channel,value)=>{const w=getWindow();if(w&&!w.isDestroyed())try{w.webContents.send(channel,value);}catch{}};
  const project=r=>({...r.agent.status(),available:r.agent.status().available===true&&r.bridge.isSessionActive()});
  const allowed=e=>{const w=getWindow();return Boolean(w&&!w.isDestroyed()&&e.sender===w.webContents&&e.senderFrame===w.webContents.mainFrame);};
  const lookup=scope=>{const key=scopeKey(scope),r=records.get(key);if(!r)throw Error('stale_runtime');return r;};
  function focus(scope){
    const next=scope==null?null:lookup(scope).key;
    focused=next;
    // Focus never exposes an old rectangle before the renderer binds its pane.
    for(const r of records.values())r.controller.setOccluded(true);
    onFocus(next!==null);
    return {ok:true};
  }
  async function allocate(scope){
    const key=scopeKey(scope);if(retired.has(key)||retired.size>=256)throw Error('stale_runtime');if(records.has(key)){const r=records.get(key);return {ok:true,connection:r.bridge.connection(),extensionPath};}
    if(records.size>=2)throw Error('browser_limit');
    const owner=Object.freeze({...scope}),r={key,scope:owner};
    r.controller=createController({origin,getWindow,ipcMain,partition:`pi-gui-runtime-${randomUUID()}`,isVisible:()=>focused===key,
      send:(channel,state)=>send(channel==='pi-gui:browser-notice'?'pi-gui:runtime-browser-notice':'pi-gui:runtime-browser-state',{scope:owner,state})});
    r.agent=createAgent({browser:r.controller,origin,onState:()=>{if(r.bridge)send('pi-gui:runtime-browser-agent-state',{scope:owner,state:project(r)});}});
    const executor={status:()=>r.agent.status(),invalidate:(...args)=>r.agent.invalidate(...args),setEnabled:v=>r.agent.setEnabled(v),
      async execute(request,options){
        if(request.action==='open'&&r.agent.status().enabled&&focused===key)send('pi-gui:runtime-browser-open',{scope:owner});
        return r.agent.execute(request,options);
      }};
    r.bridge=createBridge({agent:executor,onAvailability:()=>send('pi-gui:runtime-browser-agent-state',{scope:owner,state:project(r)})});
    records.set(key,r);
    try{await r.bridge.start();}catch{records.delete(key);r.agent.dispose();r.controller.destroy();throw Error('browser_unavailable');}
    return {ok:true,connection:r.bridge.connection(),extensionPath};
  }
  async function disposeScope(scope){
    const r=lookup(scope);await r.bridge.stop();r.agent.dispose();r.controller.destroy();records.delete(r.key);retired.add(r.key);
    if(focused===r.key){focused=null;onFocus(false);}return {ok:true};
  }
  function invalidateScope(r,body){
    const connection=r.bridge.connection();
    return new Promise((resolve,reject)=>{
      const req=http.request(new URL('/invalidate',connection.url),{method:'POST',headers:{'Content-Type':'application/json','X-Pi-Browser-Token':connection.token}},res=>{
        let text='';res.on('data',c=>{text+=c;if(text.length>4096)req.destroy();});res.on('end',()=>{try{const result=JSON.parse(text);result.ok?resolve({ok:true}):reject(Error('browser_unavailable'));}catch{reject(Error('browser_unavailable'));}});
      });req.on('error',()=>reject(Error('browser_unavailable')));req.setTimeout(3000,()=>req.destroy());req.end(JSON.stringify({requestId:randomUUID(),disable:body.disable===true,revoke:body.revoke===true}));
    });
  }
  const reply=(res,status,value)=>{if(!res.writableEnded&&!res.destroyed){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}};
  async function route(req,res){
    if(req.method!=='POST'||req.url!=='/action'||req.headers.origin||!same(req.headers['x-pi-runtime-browser-token'],token))return reply(res,403,{ok:false,code:'unauthorized'});
    let body;try{let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)throw Error('invalid_request');chunks.push(chunk);}body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reply(res,400,{ok:false,code:'invalid_request'});}
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['action','scope','disable','revoke','requestId'].includes(k))||!['allocate','invalidate','focus','dispose'].includes(body.action))return reply(res,400,{ok:false,code:'invalid_request'});
    const task=chain.catch(()=>{}).then(async()=>{
      if(disposed)throw Error('browser_unavailable');
      if(body.action==='allocate')return allocate(body.scope);
      if(body.action==='focus')return focus(body.scope);
      if(body.action==='dispose')return disposeScope(body.scope);
      const r=lookup(body.scope);return invalidateScope(r,body);
    });chain=task.catch(()=>{});
    try{return reply(res,200,await task);}catch(e){return reply(res,409,{ok:false,code:['invalid_scope','stale_runtime','browser_limit'].includes(e.message)?e.message:'browser_unavailable'});}
  }
  function handler(action,needsFocus=false){return async(event,body)=>{
    if(!allowed(event))return {ok:false,code:'desktop_required'};
    if(disposed)return {ok:false,code:'stale_runtime'};
    try{const r=lookup(body?.scope);if(needsFocus&&r.key!==focused)return {ok:false,code:'not_focused'};
      if(action==='status')return {ok:true,...project(r),opened:Boolean(r.controller.getWebContents?.()),browserState:r.controller.getState?.()};
      if(action==='enable'){if(typeof body.enabled!=='boolean')throw Error('invalid_request');if(body.enabled&&!project(r).available)return {ok:false,code:'cdp_unavailable'};return {ok:true,...await r.agent.setEnabled(body.enabled)};}
      if(action==='open')return r.controller.open();
      if(action==='navigate')return r.controller.navigate(body.url);
      if(action==='command'){if(!['back','forward','reload','stop','close'].includes(body.command))throw Error('invalid_request');if(body.command==='close'){r.controller.destroy();return {ok:true};}return r.controller.command(body.command);}
      if(action==='bounds'){r.controller.setBounds(body.rect);return {ok:true};}
      if(action==='occluded'){r.controller.setOccluded(body.occluded===true);return {ok:true};}
    }catch{return {ok:false,code:'stale_runtime'};}
  };}
  for(const action of ['status','enable','open','navigate','command','bounds','occluded'])ipcMain.handle(`pi-gui:runtime-browser-${action}`,handler(action,!['status','enable'].includes(action)));
  return {
    async start(){if(server)return;server=http.createServer((req,res)=>{route(req,res).catch(()=>reply(res,500,{ok:false,code:'browser_unavailable'}));});server.requestTimeout=5000;server.headersTimeout=5000;server.maxConnections=16;await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});url=`http://127.0.0.1:${server.address().port}`;},
    environment:()=>({PI_GUI_RUNTIME_BROWSER_URL:url,PI_GUI_RUNTIME_BROWSER_TOKEN:token}),
    isLegacyVisible:()=>focused===null&&!disposed,
    stop(){if(stopPromise)return stopPromise;disposed=true;stopPromise=(async()=>{await chain.catch(()=>{});const results=await Promise.allSettled([...records.values()].map(r=>disposeScope(r.scope)));if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=null;}url='';if(results.some(r=>r.status==='rejected'))throw Error('browser_cleanup_failed');})();return stopPromise;},
    syncBounds(){for(const r of records.values())r.controller.syncBounds();},
    // Main-process fixture inspection only; never exported by preload.
    records,
  };
}
module.exports={createRuntimeBrowserHost,scopeKey};
