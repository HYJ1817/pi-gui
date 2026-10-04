'use strict';
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
assert.ok(fs.existsSync(require('node:path').join(__dirname,'../electron/browser-agent.cjs')), 'controller exists');
const {createBrowserAgent} = require('../electron/browser-agent.cjs');
let count = 0;
async function check(name, fn) { await fn(); count++; console.log('ok '+name); }
function fixture() {
 const dbg = new EventEmitter(); let attached = false; const calls=[];
 dbg.isAttached = () => attached; dbg.attach=()=>{attached=true;}; dbg.detach=()=>{attached=false;dbg.emit('detach',{},'requested');};
 dbg.sendCommand = async (method,params) => { calls.push({method,params});
  if(method==='Accessibility.getFullAXTree') return {nodes:[{backendDOMNodeId:7,role:{value:'button'},name:{value:'Save'}},{backendDOMNodeId:8,role:{value:'textbox'},name:{value:'Name'}}]};
  if(method==='DOM.describeNode') return {node:{nodeName:'INPUT',attributes:['type','text']}};
  if(method==='DOM.getBoxModel') return {model:{content:[0,0,50,0,50,40,0,40]}};
  if(method==='Page.getLayoutMetrics') return {cssLayoutViewport:{clientWidth:800,clientHeight:600}};
  if(method==='Page.captureScreenshot') return {data:Buffer.from('png').toString('base64')};
  if(method==='DOM.resolveNode') return {object:{objectId:'obj'}};
  if(method==='Runtime.callFunctionOn') return {result:{value:true}};
  if(method==='Page.getNavigationHistory') return {currentIndex:1,entries:[{id:1,url:'https://github.com/'},{id:2,url:state.url}]};
  if(method==='Page.getFrameTree') return {frameTree:{frame:{id:'main',url:state.url}}};
  return {};
 };
 const wc = new EventEmitter(); wc.debugger=dbg; wc.getURL=()=>state.url; wc.isDestroyed=()=>false;
 let generation=1; let state={open:true,url:'http://localhost:3000/a?secret=x',title:'Page',loading:false}; const listeners=new Set();
 const browser={getWebContents:()=>wc,getGeneration:()=>generation,getState:()=>({...state}),subscribeLifecycle:fn=>{listeners.add(fn);return ()=>listeners.delete(fn);},setAgentControlled(){},open:()=>({ok:true}),navigate:url=>{state.url=url;return {ok:true};},command:()=>({ok:true})};
 const emit=type=>{for(const fn of listeners)fn({type,generation});};
 return {browser,wc,dbg,calls,emit,setUrl:u=>{state.url=u;},newGeneration:()=>{generation++;emit('created');}};
}
(async()=>{
 const f=fixture(); const states=[]; const a=createBrowserAgent({browser:f.browser,origin:'http://127.0.0.1:7788',onState:s=>states.push(s)});
 let id=0; const run=(action,args={},signal)=>a.execute({requestId:String(++id),action,args},{signal});
 await check('disabled status and operation gate',async()=>{assert.equal(a.status().enabled,false);assert.equal((await run('click',{ref:'e1'})).code,'agent_control_disabled');});
 await check('enabled attach snapshot semantic refs',async()=>{a.setEnabled(true);const s=await run('snapshot');assert.equal(s.ok,true);assert.equal(s.url,'http://localhost:3000/a');assert.equal(s.elements.length,2);assert.equal(s.count,2);f.refs=s.elements.map(x=>x.ref);});
 await check('click actual pointer down and up',async()=>{assert.equal((await run('click',{ref:f.refs[0]})).ok,true);assert.deepEqual(f.calls.filter(c=>c.method==='Input.dispatchMouseEvent').map(c=>c.params.type),['mouseMoved','mousePressed','mouseReleased']);});
 await check('fill fixed helper has text only as argument',async()=>{assert.equal((await run('fill',{ref:f.refs[1],text:'SECRET'})).ok,true);const c=f.calls.find(c=>c.method==='Runtime.callFunctionOn');assert.ok(!c.params.functionDeclaration.includes('SECRET'));assert.equal(c.params.arguments[0].value,'SECRET');});
 await check('document invalidates refs and never reuses ids',async()=>{f.emit('document');assert.equal((await run('click',{ref:f.refs[0]})).code,'stale_element_ref');const s=await run('snapshot');assert.notEqual(s.elements[0].ref,f.refs[0]);});
 await check('password and file controls are blocked before pointer or fill',async()=>{
   const original=f.dbg.sendCommand;const s=await run('snapshot');
   for(const type of ['password','file']){
    f.dbg.sendCommand=async(method,params)=>method==='DOM.describeNode'?{node:{nodeName:'INPUT',attributes:['type',type]}}:original(method,params);
    const before=f.calls.filter(c=>c.method==='Input.dispatchMouseEvent'||c.method==='Runtime.callFunctionOn').length;
    assert.equal((await run('click',{ref:s.elements[0].ref})).code,'element_not_allowed');
    assert.equal((await run('fill',{ref:s.elements[0].ref,text:'secret'})).code,'element_not_allowed');
    assert.equal(f.calls.filter(c=>c.method==='Input.dispatchMouseEvent'||c.method==='Runtime.callFunctionOn').length,before);
   }f.dbg.sendCommand=original;
 });
 await check('remote every action rejected except status',async()=>{f.setUrl('https://github.com');assert.equal((await run('snapshot')).code,'remote_origin_not_allowed');assert.equal((await run('press',{key:'Enter'})).code,'remote_origin_not_allowed');assert.equal((await run('status')).ok,true);f.setUrl('http://localhost:3000/');});
 await check('remote subframe prevents page observation and keyboard operation',async()=>{const original=f.dbg.sendCommand;f.dbg.sendCommand=async(method,params)=>method==='Page.getFrameTree'?{frameTree:{frame:{id:'main',url:'http://localhost:3000/'},childFrames:[{frame:{id:'remote',url:'https://accounts.example/'}}]}}:original(method,params);assert.equal((await run('snapshot')).code,'remote_origin_not_allowed');assert.equal((await run('press',{key:'Enter'})).code,'remote_origin_not_allowed');f.dbg.sendCommand=original;});
 await check('cancelled queued command cannot send pointer',async()=>{const abort=new AbortController();abort.abort();const n=f.calls.length;assert.equal((await run('press',{key:'Enter'},abort.signal)).code,'cancelled');assert.equal(f.calls.length,n);});
 await check('no arbitrary action',async()=>assert.equal((await run('eval',{expression:'1'})).code,'unknown_action'));
 await check('named Ctrl+Enter uses modifier and unknown key has stable error',async()=>{assert.equal((await run('press',{key:'Ctrl+Enter'})).ok,true);const c=f.calls.filter(x=>x.method==='Input.dispatchKeyEvent').at(-1);assert.equal(c.params.key,'Enter');assert.equal(c.params.modifiers,2);assert.equal((await run('press',{key:'a'})).code,'invalid_key');});
 await check('history remote entry fails before navigation side effect',async()=>{assert.equal((await run('back')).code,'remote_origin_not_allowed');assert.equal(f.calls.filter(c=>c.method==='Page.navigateToHistoryEntry').length,0);});
 await check('safe bounded network and console',async()=>{f.dbg.emit('message',{},'Network.requestWillBeSent',{requestId:'x',type:'Fetch',request:{method:'GET',url:'http://localhost:3000/api?token=SECRET',headers:{Cookie:'SECRET'},postData:'SECRET'}});f.dbg.emit('message',{},'Network.responseReceived',{requestId:'x',response:{status:404}});const n=await run('network');assert.equal(n.records[0].status,404);assert.ok(!JSON.stringify(n).includes('SECRET'));f.dbg.emit('message',{},'Runtime.executionContextCreated',{context:{id:1,origin:'http://localhost:3000',auxData:{isDefault:true,frameId:'main'}}});f.dbg.emit('message',{},'Runtime.consoleAPICalled',{executionContextId:1,type:'log',args:[{value:'hello'}]});assert.equal((await run('console')).records[0].text,'hello');});
 await check('remote child console never survives child removal',async()=>{f.dbg.emit('message',{},'Runtime.executionContextCreated',{context:{id:2,origin:'https://remote.example',auxData:{isDefault:true,frameId:'child'}}});f.dbg.emit('message',{},'Runtime.consoleAPICalled',{executionContextId:2,type:'log',args:[{value:'REMOTE_SECRET'}]});f.dbg.emit('message',{},'Page.frameDetached',{frameId:'child'});assert.ok(!JSON.stringify(await run('console')).includes('REMOTE_SECRET'));});
 await check('screenshots image content',async()=>assert.equal((await run('screenshot')).image.mimeType,'image/png'));
 await check('oversized viewport screenshot refused before capture',async()=>{const original=f.dbg.sendCommand;f.dbg.sendCommand=async(method,params)=>method==='Page.getLayoutMetrics'?{cssLayoutViewport:{clientWidth:9000,clientHeight:9000}}:original(method,params);const before=f.calls.filter(c=>c.method==='Page.captureScreenshot').length;assert.equal((await run('screenshot')).code,'screenshot_too_large');assert.equal(f.calls.filter(c=>c.method==='Page.captureScreenshot').length,before);f.dbg.sendCommand=original;});
 await check('in-flight cancellation stops next input event and preserves queue order',async()=>{
   const original=f.dbg.sendCommand;let release;let first=true;
   f.dbg.sendCommand=async(method,params)=>{if(method==='Input.dispatchKeyEvent' && first){first=false;await new Promise(r=>release=r);}return original(method,params);};
   const ac=new AbortController();const start=f.calls.length;
   const one=run('press',{key:'Enter'},ac.signal);await new Promise(r=>setImmediate(r));
   const two=run('press',{key:'Tab'});await new Promise(r=>setImmediate(r));
   assert.equal(f.calls.slice(start).filter(c=>c.method==='Input.dispatchKeyEvent').length,0);ac.abort();release();
   assert.equal((await one).code,'cancelled');assert.equal((await two).ok,true);
   assert.deepEqual(f.calls.slice(start).filter(c=>c.method==='Input.dispatchKeyEvent').map(c=>c.params.key),['Enter','Tab','Tab']);f.dbg.sendCommand=original;
 });
 await check('debugger detaches unavailable and cannot silently reattach',async()=>{f.dbg.emit('detach',{},'replaced');assert.equal(a.status().available,false);assert.equal((await run('snapshot')).code,'browser_unavailable');a.setEnabled(true);});
 await check('reattach has single event listener and single console record',async()=>{await run('snapshot');assert.equal(f.dbg.listenerCount('message'),1);assert.equal(f.dbg.listenerCount('detach'),1);f.dbg.emit('message',{},'Runtime.executionContextCreated',{context:{id:3,origin:'http://localhost:3000',auxData:{isDefault:true,frameId:'main'}}});f.dbg.emit('message',{},'Runtime.consoleAPICalled',{executionContextId:3,type:'log',args:[{value:'one-record'}]});const c=await run('console');assert.equal(c.records.filter(r=>r.text==='one-record').length,1);});
 await check('protocol timeout detaches and fences late result',async()=>{
   const g=fixture();const b=createBrowserAgent({browser:g.browser,origin:'http://127.0.0.1:7788'});b.setEnabled(true);
   const original=g.dbg.sendCommand;let late;
   g.dbg.sendCommand=(method,params)=>method==='Accessibility.getFullAXTree'?new Promise(r=>late=r):original(method,params);
   assert.equal((await b.execute({requestId:'timeout',action:'snapshot',args:{}})).code,'timeout');
   assert.equal(b.status().attached,false);assert.equal(b.status().available,false);
   assert.equal((await b.execute({requestId:'after',action:'snapshot',args:{}})).code,'browser_unavailable');
   late({nodes:[]});await new Promise(r=>setImmediate(r));assert.equal(g.calls.filter(c=>c.method==='Page.getLayoutMetrics').length,0);b.dispose();
 });
 await check('close disables and detach',async()=>{f.emit('closed');assert.equal(a.status().enabled,false);assert.equal(a.status().attached,false);});
 await check('state projection excludes page title query and text',async()=>{const s=JSON.stringify(states);assert.ok(!s.includes('SECRET'));assert.ok(!s.includes('?secret'));assert.ok(!s.includes('Page'));});
 a.dispose(); console.log(`${count}/${count} gui browser controller checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
