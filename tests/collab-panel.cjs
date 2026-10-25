const baseAssert = require('node:assert/strict');
let assertions = 0;
const assert = new Proxy(baseAssert, {
  apply(target, receiver, args) { assertions++; return Reflect.apply(target, receiver, args); },
  get(target, key) { const value = target[key]; return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value; },
});
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
let checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log('ok '+name);};
(async()=>{
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8'),{url:'http://127.0.0.1/'});
  Object.assign(global,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,CustomEvent:dom.window.CustomEvent,
    requestAnimationFrame:fn=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout});
  const {S}=await import('../public/state.js');
  const api=await import('../public/api.js');
  const {mountCollabPanel}=await import('../public/collab-panel.js');
  const {createCollabService}=await import('../server/collab-service.js');
  const {validateDocument}=await import('../lib/collab-doc.js');
  S.cwd='C:\\temp-fixture';S.workspaceGeneration=1;S.bridgeRun=1;S.state={sessionId:'native-a'};S.legacyOwner={sessionId:'native-a',runtimeGeneration:'1'};
  let doc=null,hold=null,pending=null,failSave=false;
  const scope={key:'a'.repeat(64),token:'b'.repeat(64),sessionId:'scope-session',assertCurrent(){}};
  const service=createCollabService({store:{read:()=>({doc}),write(_scope,base,value){assert.equal(base,doc?.revision??null);doc=validateDocument(value);return {doc};}}});
  const calls=[];
  global.fetch=async(url,options)=>{
    assert.equal(url,'/api/collab-documents');const body=JSON.parse(options.body);calls.push({body,headers:options.headers});
    let answer;
    try{answer=failSave&&body.action==='operations'?{ok:false,code:'collab_storage_write_failed',error:'保存失败'}:service.execute(scope,body);}
    catch(e){answer={ok:false,code:e.code,error:'操作未确认'};}
    if(hold===body.action){hold=null;return new Promise(resolve=>{pending=()=>resolve({json:async()=>answer});});}
    return {json:async()=>answer};
  };
  const tick=()=>new Promise(resolve=>setTimeout(resolve,15));
  const mount=()=>{
    const host=document.createElement('div');document.body.append(host);let alive=true,dispose;
    const view={isCurrent:()=>alive,onDispose:fn=>{dispose=fn;}};
    mountCollabPanel(host,view);
    return {host,close(){alive=false;dispose?.();host.remove();}};
  };
  const button=(host,text)=>[...host.querySelectorAll('button')].find(b=>b.textContent===text);
  let panel=mount();await tick();
  await check('open does not create; explicit template create reaches real service adapter',async()=>{
    assert.equal(doc,null);button(panel.host,'新建流程图').click();await tick();assert.equal(doc.graph.nodes.length,3);assert.equal(panel.host.querySelectorAll('[data-node-id]').length,3);
    assert.match(panel.host.textContent,/版本 1 · 已保存/);assert.match(panel.host.textContent,/来源尚未接入/);
  });
  await check('pending durable update keeps visible prior document until acknowledged',async()=>{
    hold='operations';button(panel.host,'新增节点').click();await tick();assert.equal(doc.graph.nodes.length,4);assert.equal(panel.host.querySelectorAll('[data-node-id]').length,3);
    assert.equal(button(panel.host,'新增节点').disabled,true);pending();await tick();assert.equal(panel.host.querySelectorAll('[data-node-id]').length,4);
    assert.equal(calls.find(c=>c.body.action==='operations').body.ops[0].actor,'user');
    assert.equal(calls.at(-1).headers['X-Pi-Gui-Owner'],JSON.stringify(S.legacyOwner));
  });
  await check('failed save keeps current graph and exposes error',async()=>{
    failSave=true;button(panel.host,'新增节点').click();await tick();assert.equal(panel.host.querySelectorAll('[data-node-id]').length,4);assert.equal(doc.graph.nodes.length,4);assert.match(panel.host.textContent,/保存失败/);assert.equal(button(panel.host,'重新打开').hidden,false);failSave=false;
  });
  panel.close();panel=mount();await tick();
  await check('close and reopen preserves document but clears server history',async()=>{
    assert.equal(panel.host.querySelectorAll('[data-node-id]').length,4);assert.equal(button(panel.host,'撤销').disabled,true);
  });
  await check('closing panel dismisses only its own pending deletion confirmation',async()=>{
    panel.host.querySelector('[data-node-id="n1"]').dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
    button(panel.host,'删除所选').click();await tick();assert.equal(document.querySelector('#confirmLayer').hidden,false);
    panel.close();assert.equal(document.querySelector('#confirmLayer').hidden,true);
    panel=mount();await tick();
  });
  await check('closing editor leaves unrelated approval confirmation in place',async()=>{
    const modal=await import('../public/ui/modal.js');
    const decision=modal.confirmModal({title:'其他功能确认',message:'独立审批',meta:{other:'approval'}});
    panel.close();assert.equal(document.querySelector('#confirmLayer').hidden,false);assert.equal(modal.confirmSurfaceMeta().other,'approval');
    modal.dismissConfirm();assert.equal(await decision,false);panel=mount();await tick();
  });
  await check('session-switch invalidates synchronously before legacy owner fields change',async()=>{
    const owner=JSON.stringify(S.legacyOwner);document.dispatchEvent(new window.CustomEvent('pi-gui:session-switch'));
    assert.equal(JSON.stringify(S.legacyOwner),owner);assert.equal(panel.host.querySelectorAll('[data-node-id]').length,0);
    panel.close();panel=mount();await tick();
  });
  await check('workspace change synchronously clears graph; late save cannot repaint',async()=>{
    hold='operations';button(panel.host,'新增节点').click();await tick();S.workspaceGeneration++;
    document.dispatchEvent(new window.CustomEvent('pi-gui:workspace-generation'));
    assert.equal(panel.host.querySelectorAll('[data-node-id]').length,0);pending();await tick();assert.equal(panel.host.querySelectorAll('[data-node-id]').length,0);
  });
  panel.close();panel=mount();await tick();
  await check('owner changed without response cannot send a fresh edit',async()=>{
    const count=calls.length;S.legacyOwner={...S.legacyOwner,runtimeGeneration:'2'};
    button(panel.host,'新增节点').click();await tick();assert.equal(calls.length,count);
    document.dispatchEvent(new window.CustomEvent('pi-gui:session-evidence-context'));assert.equal(panel.host.querySelectorAll('[data-node-id]').length,0);
  });
  panel.close();hold='open';panel=mount();await tick();panel.close();pending();await tick();
  await check('late open after close is disposed and closes orphan capability',()=>{
    assert.equal(document.querySelector('.collab-canvas'),null);assert.equal(calls.at(-1).body.action,'close');
  });
  await check('focused runtime headers use runtime owner and never classic owner',async()=>{
    const {runtimeStore,refreshRuntimeViews}=await import('../public/runtime-state.js');
    const record={owner:{sessionId:'native-runtime',runtimeGeneration:'5'},item:{lifecycle:'ready'}};
    const original=runtimeStore.get;runtimeStore.get=id=>id==='runtime-a'?record:original.call(runtimeStore,id);
    const {showRuntimeConversation,showChat}=await import('../public/ui/workspace-surface.js');
    api.setGitConversationScope('runtime-a');showRuntimeConversation();panel=mount();await tick();
    const last=calls.findLast(c=>c.body.action==='open');assert.equal(last.headers['X-Pi-Gui-Conversation'],'runtime-a');assert.match(last.headers['X-Pi-Gui-Owner'],/native-runtime/);
    S.bridgeRun++;S.legacyOwner={...S.legacyOwner,sessionId:'unrelated-classic-restart'};
    document.dispatchEvent(new window.CustomEvent('pi-gui:session-evidence-context'));
    assert.notEqual(panel.host.querySelectorAll('[data-node-id]').length,0,'Classic bridge changes must not invalidate a different Runtime owner');
    record.item.lifecycle='dormant';refreshRuntimeViews();assert.equal(panel.host.querySelectorAll('[data-node-id]').length,0);
    api.setGitConversationScope('runtime-b');assert.equal(panel.host.querySelectorAll('[data-node-id]').length,0);
    panel.close();runtimeStore.get=original;api.setGitConversationScope(null);showChat();
  });
  dom.window.close();console.log(`Collab panel: ${checks}/${checks}; assertions=${assertions}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
