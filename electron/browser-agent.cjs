/* Closed CDP controller for the existing WebContentsView. No protocol passthrough.
 * Promise queue deliberately waits for pending CDP work even after cancellation:
 * an in-flight protocol command cannot be undone; releasing early would race it. */
'use strict';
const {allowedAgentUrl,safeUrl,validateRequest,KEYS} = require('./browser-agent-policy.cjs');
const MAX_IMAGE = 4 * 1024 * 1024;
const FILL = `function(text) {
  if (!this.isConnected || this.disabled || this.readOnly) return false;
  const tag = this.tagName;
  if (tag === 'INPUT' && ['password','file','hidden'].includes(this.type)) return false;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !this.isContentEditable) return false;
  this.focus();
  if (this.isContentEditable) this.textContent = text;
  else {
    const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(this, text);
  }
  this.dispatchEvent(new Event('input', {bubbles:true}));
  this.dispatchEvent(new Event('change', {bubbles:true}));
  return true;
}`;
const fault = code => Object.assign(new Error(code), {code});
const cut = (v,n=1000) => String(v ?? '').slice(0,n);
function createBrowserAgent({browser,origin,onState=()=>{}}) {
  let enabled=false, disposed=false, unavailable=false, attachedWc=null, queue=Promise.resolve(), pending=0, epoch=0, document=0, nextRef=0;
  let busy=false, refs=new Map(), consoleRecords=[], networkRecords=new Map();
  let mainFrameId=null; const executionContexts=new Map(); const remoteFrames=new Set();
  function status() {
    const s=browser.getState(); const wc=browser.getWebContents();
    return {available:!disposed && !unavailable,enabled,open:s.open===true,attached:Boolean(attachedWc && attachedWc.debugger.isAttached()),generation:browser.getGeneration(),urlOrigin:safeUrl(s.url).split('/').slice(0,3).join('/'),loading:s.loading===true,busy,runtimeObserved:null};
  }
  const emit=()=>{try{onState(status());}catch{}};
  async function bounded(work){
    let timer;
    try{return await Promise.race([work,new Promise((_resolve,reject)=>{timer=setTimeout(()=>{
      unavailable=true;epoch++;clearDocument();detach();emit();reject(fault('timeout'));
    },5000);})]);}finally{clearTimeout(timer);}
  }
  function clearDocument(){document++;refs.clear();}
  function detach(){
    const wc=attachedWc; attachedWc=null;
    if(wc){wc.debugger.removeListener('message',message);wc.debugger.removeListener('detach',lost);try{if(wc.debugger.isAttached())wc.debugger.detach();}catch{}}
  }
  function lost(){
    const old=attachedWc;attachedWc=null;
    if(old){old.debugger.removeListener('message',message);old.debugger.removeListener('detach',lost);}
    unavailable=true;epoch++;clearDocument();executionContexts.clear();remoteFrames.clear();emit();
  }
  function message(_event,method,p) {
    if(method==='Runtime.executionContextCreated'){
      const c=p.context||{};executionContexts.set(c.id,{frameId:c.auxData?.frameId,default:c.auxData?.isDefault===true,local:allowedAgentUrl(c.origin,origin)});return;
    }
    if(method==='Runtime.executionContextDestroyed'){executionContexts.delete(p.executionContextId);return;}
    if(method==='Runtime.executionContextsCleared'){executionContexts.clear();return;}
    if(method==='Page.frameDetached'){remoteFrames.delete(p.frameId);return;}
    if(method==='Page.frameNavigated'){
      const f=p.frame||{};
      if(!f.parentId){mainFrameId=f.id;remoteFrames.clear();clearDocument();}
      else if(!allowedAgentUrl(f.url,origin)&&!['about:blank','about:srcdoc'].includes(f.url))remoteFrames.add(f.id);
      else remoteFrames.delete(f.id);
      return;
    }
    // Chromium events can arrive after manual remote navigation. Do not collect there.
    const currentLocal=allowedAgentUrl(browser.getWebContents()?.getURL?.(),origin);
    const pendingLocalRequest=method==='Network.requestWillBeSent' && browser.getState().loading && allowedAgentUrl(browser.getState().url,origin) && allowedAgentUrl(p.request?.url,origin);
    if(!enabled || (!currentLocal && !pendingLocalRequest)) return;
    if(remoteFrames.size)return;
    if(method==='Runtime.consoleAPICalled') {
      const c=executionContexts.get(p.executionContextId);
      if(!c || !c.default || !c.local || c.frameId!==mainFrameId)return;
      const text=(p.args||[]).map(a=>typeof a.value==='string'||typeof a.value==='number'||typeof a.value==='boolean'?String(a.value):cut(a.description,200)).join(' ');
      consoleRecords.push({level:cut(p.type,30),text:cut(text),source:'console'});
    } else if(method==='Log.entryAdded') {
      // Log domain lacks execution-context provenance. Only local source URLs
      // are usable; unknown/remote sources are omitted conservatively.
      if(!allowedAgentUrl(p.entry?.url,origin))return;
      consoleRecords.push({level:cut(p.entry?.level,30),text:cut(p.entry?.text),source:cut(p.entry?.source,30),...(Number.isInteger(p.entry?.lineNumber)?{line:p.entry.lineNumber}: {})});
    } else if(method==='Network.requestWillBeSent') {
      if(p.frameId && p.frameId!==mainFrameId)return;
      const r=p.request||{};
      networkRecords.set(p.requestId,{method:/^[A-Z]{1,16}$/.test(r.method)?r.method:'OTHER',url:cut(safeUrl(r.url),2048),status:null,resourceType:cut(p.type,30),failed:false});
      if(networkRecords.size>100)networkRecords.delete(networkRecords.keys().next().value);
    } else if(method==='Network.responseReceived') {
      const r=networkRecords.get(p.requestId);if(r)r.status=Number.isFinite(p.response?.status)?p.response.status:null;
    } else if(method==='Network.loadingFailed') { const r=networkRecords.get(p.requestId);if(r)r.failed=true;
    }
    while(consoleRecords.length>100 || Buffer.byteLength(JSON.stringify(consoleRecords))>65536)consoleRecords.shift();
    while(networkRecords.size && Buffer.byteLength(JSON.stringify(Array.from(networkRecords.values())))>65536)networkRecords.delete(networkRecords.keys().next().value);
  }
  const unsubscribe=browser.subscribeLifecycle(({type})=>{
    if(type==='document')clearDocument();
    if(type==='manual'){invalidate();}
    if(type==='created'){clearDocument();consoleRecords=[];networkRecords.clear();executionContexts.clear();remoteFrames.clear();mainFrameId=null;unavailable=false;}
    if(type==='closed'||type==='unavailable'){enabled=false;epoch++;clearDocument();consoleRecords=[];networkRecords.clear();detach();unavailable=type==='unavailable';}
    emit();
  });
  function invalidate(){epoch++;clearDocument();consoleRecords=[];networkRecords.clear();emit();}
  function setEnabled(value){
    const next=value===true && !disposed;
    if(enabled===next && !unavailable)return status();
    enabled=next;epoch++;clearDocument();consoleRecords=[];networkRecords.clear();executionContexts.clear();remoteFrames.clear();unavailable=false;
    if(!enabled){detach();browser.setAgentControlled?.(false);}emit();return status();
  }
  function getUrl(){try{return browser.getWebContents()?.getURL()||browser.getState().url;}catch{return '';}}
  async function perform(request,signal,captured) {
    let wc=null;
    const args=request.args||{};
    function check(local=true){
      if(disposed)throw fault('browser_unavailable');
      if(signal?.aborted)throw fault('cancelled');
      if(epoch!==captured.epoch || browser.getGeneration()!==captured.generation)throw fault('stale_browser_generation');
      if(!enabled)throw fault('agent_control_disabled');
      if(local && !browser.getState().open)throw fault('browser_closed');
      if(local && !allowedAgentUrl(getUrl(),origin))throw fault('remote_origin_not_allowed');
      if(local && browser.getState().loading && !allowedAgentUrl(browser.getState().url,origin))throw fault('remote_origin_not_allowed');
      if(wc && (wc!==browser.getWebContents() || wc.isDestroyed?.()))throw fault('stale_browser_generation');
    }
    async function cdp(method,params={}){check();const out=await bounded(wc.debugger.sendCommand(method,params));check();return out;}
    async function ensureAttached({beforeNavigation=false}={}){
      wc=browser.getWebContents();if(!wc||wc.isDestroyed?.())throw fault('browser_unavailable');
      if(unavailable)throw fault('browser_unavailable');
      if(attachedWc===wc && wc.debugger.isAttached())return;
      try {if(browser.ready)await bounded(browser.ready());check(!beforeNavigation);wc.debugger.attach('1.3');attachedWc=wc;wc.debugger.on('message',message);wc.debugger.on('detach',lost);
        // Only fixed domain setup may run on the old/blank document when open is
        // about to navigate. Attach first so initial console/network isn't lost.
        for(const domain of ['Runtime','Log','Network','Page','Accessibility']){
          check(!beforeNavigation);await bounded(wc.debugger.sendCommand(domain+'.enable'));check(!beforeNavigation);
        }
        check(!beforeNavigation);await bounded(wc.debugger.sendCommand('Page.setInterceptFileChooserDialog',{enabled:true}));check(!beforeNavigation);
      }catch(e){detach();if(e.code)throw e;throw fault('cdp_attach_failed');}
      emit();
    }
    async function waitLoading({navigation=false}={}){
      // Input/history dispatch can resolve before Chromium's loading event is
      // delivered. Let that event settle before deciding the page is idle.
      check(!navigation);await new Promise(r=>setTimeout(r,40));check(!navigation);
      const start=Date.now();
      while(browser.getState().loading){check(!navigation);if(Date.now()-start>10000)throw fault('timeout');await new Promise(r=>setTimeout(r,30));}
      check();
      if(browser.getState().error)throw fault('navigation_failed');
    }
    function page(){const s=browser.getState();return {url:safeUrl(getUrl()),title:cut(s.title,300),loading:s.loading===true,generation:browser.getGeneration()};}
    if(request.action==='status')return {ok:true,...status()};
    check(request.action!=='open');
    busy=true;emit();
    try {
      if(request.action==='open'){
        if(!allowedAgentUrl(args.url,origin))throw fault('remote_origin_not_allowed');
        check(false);const before=browser.getGeneration();const opened=browser.open();if(!opened.ok)throw fault('browser_unavailable');
        // Opening is the sole permitted creation transition for this request.
        if(browser.getGeneration()!==before)captured.generation=browser.getGeneration();
        check(false);browser.setAgentControlled?.(true);clearDocument();
        await ensureAttached({beforeNavigation:true});
        if(!browser.navigate(args.url,{agent:true}).ok)throw fault('navigation_failed');
        await waitLoading({navigation:true});return {ok:true,...page()};
      }
      await ensureAttached();
      browser.setAgentControlled?.(true);
      const frameTree=await cdp('Page.getFrameTree');
      mainFrameId=frameTree.frameTree?.frame?.id||mainFrameId;
      const visitFrame=(tree)=>{
        if(!tree)return;
        const url=tree.frame?.url;
        // about:blank/srcdoc inherit the checked parent origin. Remote frames
        // are rejected before snapshot, screenshot, keyboard or pointer work.
        if(url && !['about:blank','about:srcdoc'].includes(url) && !allowedAgentUrl(url,origin))throw fault('remote_origin_not_allowed');
        for(const child of tree.childFrames||[])visitFrame(child);
      };
      visitFrame(frameTree.frameTree);
      if(['back','forward','reload'].includes(request.action)){
        check();clearDocument();
        if(request.action==='reload') {
          const r=browser.command(request.action,{agent:true});if(!r.ok)throw fault('navigation_failed');
        } else {
          const h=await cdp('Page.getNavigationHistory');
          const entry=h.entries?.[h.currentIndex+(request.action==='back'?-1:1)];
          if(entry){if(!allowedAgentUrl(entry.url,origin))throw fault('remote_origin_not_allowed');await cdp('Page.navigateToHistoryEntry',{entryId:entry.id});}
        }
        await waitLoading();return {ok:true,...page()};
      }
      if(request.action==='snapshot'){
        const doc=document;const {nodes=[]}=await cdp('Accessibility.getFullAXTree');
        const metrics=await cdp('Page.getLayoutMetrics');if(doc!==document)throw fault('stale_element_ref');
        refs.clear();const elements=[];const texts=[];
        for(const node of nodes.slice(0,5000)){
          if(node.ignored)continue;
          const role=cut(node.role?.value,50),name=cut(node.name?.value,300);
          // AX values are intentionally omitted, including password/input values.
          if(role==='StaticText' && name && texts.join('\n').length<16000)texts.push(name);
          if(node.backendDOMNodeId && !['StaticText','InlineTextBox','generic','none'].includes(role) && elements.length<300){
            const ref='e'+(++nextRef);refs.set(ref,{backendNodeId:node.backendDOMNodeId,document,generation:captured.generation});elements.push({ref,role,name});
          }
        }
        const v=metrics.cssLayoutViewport||metrics.layoutViewport||{};
        return {ok:true,...page(),viewport:{width:v.clientWidth||0,height:v.clientHeight||0},text:texts.join('\n').slice(0,16000),elements,count:elements.length};
      }
      if(['click','fill'].includes(request.action)){
        const ref=refs.get(args.ref);if(!ref || ref.document!==document || ref.generation!==captured.generation)throw fault('stale_element_ref');
        const refCheck=()=>{check();if(ref.document!==document)throw fault('stale_element_ref');};
        refCheck();const {node}=await cdp('DOM.describeNode',{backendNodeId:ref.backendNodeId});refCheck();
        const attrs=Object.fromEntries((node.attributes||[]).reduce((a,v,i,all)=>{if(i%2===0)a.push([v,all[i+1]]);return a;},[]));
        if(node.nodeName==='INPUT' && ['file','password','hidden'].includes(String(attrs.type||'').toLowerCase()))throw fault('element_not_allowed');
        if(request.action==='click'){
          await cdp('DOM.scrollIntoViewIfNeeded',{backendNodeId:ref.backendNodeId});refCheck();
          const {model}=await cdp('DOM.getBoxModel',{backendNodeId:ref.backendNodeId});refCheck();
          const q=model?.content;if(!Array.isArray(q)||q.length!==8)throw fault('element_not_interactable');
          const x=(q[0]+q[2]+q[4]+q[6])/4,y=(q[1]+q[3]+q[5]+q[7])/4;
          if(!Number.isFinite(x)||!Number.isFinite(y))throw fault('element_not_interactable');
          for(const type of ['mouseMoved','mousePressed','mouseReleased']){refCheck();await cdp('Input.dispatchMouseEvent',{type,x,y,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})});}
        }else{
          const {object}=await cdp('DOM.resolveNode',{backendNodeId:ref.backendNodeId});refCheck();
          try {
            const r=await cdp('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:FILL,arguments:[{value:args.text}],returnByValue:true});
            if(r.result?.value!==true)throw fault('element_not_interactable');
          }finally{try{if(attachedWc===wc)await bounded(wc.debugger.sendCommand('Runtime.releaseObject',{objectId:object.objectId}));}catch{}}
        }
        await waitLoading();return {ok:true,ref:args.ref,generation:captured.generation};
      }
      if(request.action==='press'){
        for(const type of ['keyDown','keyUp'])await cdp('Input.dispatchKeyEvent',{type,...KEYS[args.key],...(args.key==='Enter'&&type==='keyDown'?{text:'\r'}:{})});
        await waitLoading();return {ok:true,key:args.key,generation:captured.generation};
      }
      if(request.action==='screenshot'){
        const m=await cdp('Page.getLayoutMetrics');const v=m.cssLayoutViewport||m.layoutViewport||{};
        if(!(v.clientWidth>0&&v.clientHeight>0&&v.clientWidth<=4096&&v.clientHeight<=4096&&v.clientWidth*v.clientHeight<=8388608))throw fault('screenshot_too_large');
        const r=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true});
        if(typeof r.data!=='string'||r.data.length>Math.ceil(MAX_IMAGE/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(r.data))throw fault('screenshot_too_large');
        return {ok:true,image:{data:r.data,mimeType:'image/png'},width:v.clientWidth,height:v.clientHeight,generation:captured.generation};
      }
      if(request.action==='console'||request.action==='network'){
        const records=(request.action==='console'?consoleRecords:Array.from(networkRecords.values())).slice(-(args.limit||50));
        return {ok:true,records:records.map(r=>({...r})),count:records.length,generation:captured.generation};
      }
      throw fault('unknown_action');
    }finally{busy=false;emit();}
  }
  function execute(request,{signal}={}) {
    const code=validateRequest(request);if(code)return Promise.resolve({ok:false,code});
    if(pending>=64)return Promise.resolve({ok:false,code:'busy'});
    const captured={epoch,generation:browser.getGeneration()};pending++;
    const work=queue.then(()=>perform(request,signal,captured)).catch(e=>({ok:false,code:e.code||'cdp_error'})).finally(()=>{pending--;});
    queue=work.then(()=>{});return work;
  }
  function dispose(){disposed=true;enabled=false;invalidate();detach();unsubscribe();}
  emit();return {execute,setEnabled,status,invalidate,dispose};
}
module.exports={createBrowserAgent};
