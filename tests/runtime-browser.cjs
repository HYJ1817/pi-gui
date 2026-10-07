'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),Module=require('node:module'),{EventEmitter}=require('node:events');
const {createRuntimeBrowserHost}=require('../electron/browser-runtime-host.cjs');
let checks=0;const ok=v=>{assert.ok(v);checks++;};
function request(url,token,body,header='X-Pi-Runtime-Browser-Token',origin){return new Promise((resolve,reject)=>{
  const req=http.request(new URL('/action',url),{method:'POST',headers:{'Content-Type':'application/json',[header]:token,...(origin?{Origin:origin}:{})}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,...JSON.parse(text)}));});req.on('error',reject);req.end(JSON.stringify(body));
});}
function browserRequest(connection,path,body,token=connection.token){return new Promise((resolve,reject)=>{
  const req=http.request(new URL(path,connection.url),{method:'POST',headers:{'Content-Type':'application/json','X-Pi-Browser-Token':token}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,...JSON.parse(text)}));});req.on('error',reject);req.end(JSON.stringify(body));
});}
(async()=>{
  const handlers=new Map(),sent=[],controllers=[],agents=[],focused=[];
  const attached=new Set(),sessions=new Map();
  const sender={mainFrame:{},send:(channel,payload)=>sent.push({channel,payload})},window={webContents:sender,isDestroyed:()=>false,
    getContentBounds:()=>({width:1440,height:900}),contentView:{addChildView:view=>attached.add(view),removeChildView:view=>attached.delete(view)}};
  const originalLoad=Module._load;
  let createBrowserController;
  try{
    Module._load=function(name,...args){
      if(name==='electron')return {shell:{openExternal:async()=>{}},session:{fromPartition:partition=>{
        if(!sessions.has(partition)){const s=new EventEmitter();s.setPermissionRequestHandler=()=>{};s.setPermissionCheckHandler=()=>{};sessions.set(partition,s);}return sessions.get(partition);
      }},WebContentsView:class{
        constructor(opts){this.webContents=new EventEmitter();this.webContents.session=sessions.get(opts.webPreferences.partition);this.webContents.loadURL=async()=>{};this.webContents.setWindowOpenHandler=()=>{};this.webContents.close=()=>{this.webContents.emit('destroyed');};}
        setBackgroundColor(){}setBounds(){}
      }};
      return originalLoad.call(this,name,...args);
    };
    ({createBrowserController}=require('../electron/browser-view.cjs'));
  }finally{Module._load=originalLoad;}
  let host;
  const legacy=createBrowserController({origin:'http://127.0.0.1:7788',getWindow:()=>window,ipcMain:{},send:()=>{},isVisible:()=>!host||host.isLegacyVisible()});
  const event={sender,senderFrame:sender.mainFrame};
  host=createRuntimeBrowserHost({origin:'http://127.0.0.1:7788',getWindow:()=>window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},extensionPath:'PRIVATE_EXTENSION_PATH',onFocus:flag=>{focused.push(flag);legacy.setOccluded(flag);},
    createController:opts=>{const c={opts,closed:false,hidden:true,opened:false,setOccluded:v=>{c.hidden=v;},destroy:()=>{c.closed=true;},open:()=>{c.opened=true;return {ok:true};},navigate:url=>({ok:true}),command:()=>({ok:true}),setBounds(){},syncBounds(){}};controllers.push(c);return c;},
    createAgent:({onState})=>{let enabled=false,disposed=false,invalidations=0;const a={status:()=>({available:!disposed,enabled,generation:1}),setEnabled:v=>{enabled=v&&!disposed;onState();return a.status();},invalidate:()=>{invalidations++;},execute:async request=>({ok:true,owner:agents.indexOf(a),action:request.action}),dispose:()=>{disposed=true;enabled=false;},invalidations:()=>invalidations};agents.push(a);return a;},
  });
  const scope=id=>({backendInstance:'backend',runtimeId:id,runtimeGeneration:'generation-'+id,projectId:'project',workspaceId:'workspace-'+id,workspaceEpoch:'epoch-'+id,conversationId:'conversation-'+id});
  const A=scope('A'),B=scope('B');
  try{
    await host.start();const env=host.environment(),url=env.PI_GUI_RUNTIME_BROWSER_URL,token=env.PI_GUI_RUNTIME_BROWSER_TOKEN;
    legacy.open();ok(attached.size===1&&host.isLegacyVisible());
    const act=body=>request(url,token,body);
    ok((await request(url,'wrong',{action:'allocate',scope:A})).status===403);
    ok((await request(url,token,{action:'allocate',scope:A},undefined,'http://localhost')).status===403);
    const a=await act({action:'allocate',scope:A}),b=await act({action:'allocate',scope:B});ok(a.ok&&b.ok);
    ok(a.connection.token!==b.connection.token&&a.connection.url!==b.connection.url);
    ok(controllers[0].opts.partition!==controllers[1].opts.partition);
    ok(!controllers[0].opts.isVisible()&&!controllers[1].opts.isVisible());
    ok((await act({action:'allocate',scope:scope('C')})).code==='browser_limit');
    ok((await act({action:'allocate',scope:{...A,runtimeId:'../escape'}})).code==='browser_limit');
    ok((await act({action:'allocate',scope:{...A,extra:'unknown'}})).code==='invalid_scope');
    ok((await act({action:'allocate',scope:{...A}})).connection.token===a.connection.token);
    const enable=handlers.get('pi-gui:runtime-browser-enable'),status=handlers.get('pi-gui:runtime-browser-status'),open=handlers.get('pi-gui:runtime-browser-open');
    ok((await enable(event,{scope:A,enabled:true})).code==='cdp_unavailable');
    const as=await browserRequest(a.connection,'/session',{requestId:'session-A'}),bs=await browserRequest(b.connection,'/session',{requestId:'session-B'});ok(as.ok&&bs.ok);
    ok((await enable({...event,sender:{}},{scope:A,enabled:true})).code==='desktop_required');
    ok((await enable({...event,senderFrame:{}},{scope:A,enabled:true})).code==='desktop_required');
    ok((await enable(event,{scope:A,enabled:true})).enabled===true);ok((await enable(event,{scope:B,enabled:true})).enabled===true);
    ok((await open(event,{scope:A})).code==='not_focused');
    await act({action:'focus',scope:A});ok(controllers[0].opts.isVisible()&&!controllers[1].opts.isVisible()&&focused.at(-1)===true);
    ok((await open(event,{scope:A})).ok===true);
    await act({action:'focus',scope:B});ok(controllers[0].hidden===true&&controllers[1].hidden===true);
    ok(!controllers[0].closed&&!controllers[1].closed);
    await handlers.get('pi-gui:runtime-browser-occluded')(event,{scope:B,occluded:false});
    ok(controllers[1].hidden===false&&controllers[0].hidden===true);
    ok(attached.size===0&&!host.isLegacyVisible());
    legacy.destroy();legacy.open();ok(attached.size===0&&!host.isLegacyVisible());
    legacy.setOccluded(false);legacy.syncBounds();legacy.open();ok(attached.size===0);
    ok((await open(event,{scope:A})).code==='not_focused');
    const args={requestId:'same-id',action:'status',args:{},generation:1};
    const ar=await browserRequest(a.connection,'/action',{...args,epoch:as.epoch},as.token),br=await browserRequest(b.connection,'/action',{...args,epoch:bs.epoch},bs.token);ok(ar.owner===0&&br.owner===1);
    ok((await browserRequest(b.connection,'/action',{...args,requestId:'cross',epoch:bs.epoch},as.token)).status===403);
    await act({action:'invalidate',scope:A,disable:true,revoke:true});ok((await status(event,{scope:A})).enabled===false);
    ok((await browserRequest(a.connection,'/state',{requestId:'old-token'},as.token)).status===403);
    ok((await status(event,{scope:B})).enabled===true);
    ok(!JSON.stringify(sent).includes(token)&&!JSON.stringify(sent).includes(a.connection.token)&&!JSON.stringify(sent).includes(as.token)&&!JSON.stringify(sent).includes('PRIVATE_EXTENSION_PATH'));
    ok(sent.every(e=>e.channel.startsWith('pi-gui:runtime-browser-')));
    await act({action:'dispose',scope:A});ok(controllers[0].closed);
    ok((await status(event,{scope:A})).code==='stale_runtime');
    ok((await act({action:'allocate',scope:A})).code==='stale_runtime');
    ok((await status(event,{scope:B})).enabled===true);
    await act({action:'focus',scope:null});ok(focused.at(-1)===false&&controllers[1].hidden===true);
    ok(host.isLegacyVisible()&&attached.size===1);
    await act({action:'focus',scope:B});ok(!host.isLegacyVisible()&&attached.size===0);
    await act({action:'dispose',scope:B});ok(host.isLegacyVisible()&&attached.size===1);
    const b2={...B,runtimeGeneration:'new-generation-B'};await act({action:'allocate',scope:b2});await act({action:'focus',scope:b2});
    ok(!host.isLegacyVisible()&&attached.size===0);
    const stopping=host.stop();ok((await status(event,{scope:b2})).code==='stale_runtime');
    ok(host.stop()===stopping);await stopping;ok(controllers[1].closed);
    ok((await status(event,{scope:b2})).code==='stale_runtime');console.log(`Runtime Browser scope HTTP/IPC isolation: ${checks}/${checks}`);
  }finally{await host.stop();legacy.destroy();}
})().catch(e=>{console.error(e);process.exitCode=1;});
