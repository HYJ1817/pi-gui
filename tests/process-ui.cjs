const assert=require('node:assert/strict');const {JSDOM}=require('jsdom');let checks=0;const ok=v=>{assert.ok(v);checks++;};
(async()=>{
  const dom=new JSDOM(require('node:fs').readFileSync(require('node:path').join(__dirname,'../public/index.html'),'utf8'),{url:'http://127.0.0.1/'});global.document=dom.window.document;global.window=dom.window;global.CustomEvent=dom.window.CustomEvent;
  const {S,beginWorkspaceSwitch}=await import('../public/state.js');const {configureSecondaryPane}=await import('../public/ui/secondary-surface.js');const {openProcessPanel}=await import('../public/process-panel.js');
  const {makeEntry,applyEnd}=await import('../public/tool-model.js');const {renderEntry,updateEntry}=await import('../public/tool-view.js');
  for(const action of ['start','status','logs','stop','restart']){
    const entry=makeEntry({toolCallId:action,toolName:'gui_process_'+action,args:{command:'RAW_SECRET',env:{API_KEY:'RAW_SECRET'},args:['RAW_SECRET']}},1);const node=renderEntry(entry);document.body.append(node);ok(!node.outerHTML.includes('RAW_SECRET'));
    applyEnd(entry,{result:{content:[{type:'text',text:'RAW_SECRET'}],details:{ok:true,process:{state:'ready'},logs:'RAW_SECRET',env:'RAW_SECRET'}}},3);updateEntry(node,entry);ok(!node.outerHTML.includes('RAW_SECRET'));node.remove();
  }
  let listener,resolveLogs,resolveList;let generation='A',fetches=0;
  configureSecondaryPane({root:document.getElementById('rightPane'),onSurfaceChange:fn=>listener=fn,open:()=>{},close:()=>listener(null)});S.hasProject=true;
  global.fetch=async url=>{
    if(url.includes('?')){fetches++;return {json:()=>new Promise(r=>resolveLogs=r)};}
    return {json:async()=>({ok:true,generation,enabled:true,processes:generation==='A'?[{id:'owned-A',revision:1,command:'node',argCount:1,state:'ready',uptimeMs:100,endpoint:null}]:[]})};
  };
  openProcessPanel();for(let i=0;i<20&&!resolveLogs;i++)await new Promise(r=>setImmediate(r));ok(fetches===1);ok(!!document.querySelector('.process-row'));
  beginWorkspaceSwitch('B');generation='B';ok(!document.querySelector('.process-row'));ok(document.querySelector('.process-permission input').disabled);
  resolveLogs({ok:true,lines:[{cursor:1,text:'OLD_A_SECRET'}],cursor:1});await new Promise(r=>setImmediate(r));ok(!document.body.textContent.includes('OLD_A_SECRET'));
  beginWorkspaceSwitch('A');generation='A2';await new Promise(r=>setTimeout(r,1100));ok(!document.querySelector('.process-row'));listener(null);delete global.fetch;
  console.log(`Process UI: ${checks}/${checks}`);dom.window.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
