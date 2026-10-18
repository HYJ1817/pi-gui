/* Actual integrated app; all fixture writes live in os.tmpdir. No Pi/network. */
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),OUT=process.env.UI3_EVIDENCE_ROOT||path.join(ROOT,'docs/claude-ui-redesign/ui3-integration-evidence',process.env.UI3_ASSETS_ROOT?'packaged-electron':'electron');
if(!process.versions.electron){
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'ui3-integrated-electron-')),env={...process.env,UI3_WORLD:world};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(require('electron'),[__filename],{env,stdio:'inherit',windowsHide:false});
 child.on('error',e=>{console.error(e);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;fs.rm(world,{recursive:true,force:true,maxRetries:20,retryDelay:100},()=>{});});
}else run();
async function run(){
 const {app,BrowserWindow,ipcMain}=require('electron');
 const {createBrowserController}=require('../electron/browser-view.cjs'),{createBrowserAgentHost}=require('../electron/browser-agent-host.cjs');
 app.setPath('userData',process.env.UI3_WORLD);app.on('window-all-closed',()=>{});
 let win,harness,browser,agent;const checks=[],facts=[],screenshots=[],errors=[],start=Date.now();
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));const read=s=>win.webContents.executeJavaScript(s,true);
 const check=(pass,name,detail)=>{checks.push({pass:!!pass,name,detail});console.log((pass?'PASS ':'FAIL ')+name+(pass?'':' '+JSON.stringify(detail)));};
 const timeout=setTimeout(()=>{console.error('UI3 integrated Electron timeout');app.exit(1);},240000);
 async function shot(name){fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());screenshots.push(name+'.png');}
 async function input(value){await read(`ST.el.input.value=${JSON.stringify(value)};ST.el.input.setSelectionRange(ST.el.input.value.length,ST.el.input.value.length);ST.el.input.focus();ST.el.input.dispatchEvent(new Event('input',{bubbles:true}))`);await sleep(180);}
 async function key(name,modifiers=[]){
  const vk={Enter:13,Escape:27,K:75}[name],code={Enter:'Enter',Escape:'Escape',K:'KeyK'}[name];
  const params={key:name==='K'?'k':name,code,windowsVirtualKeyCode:vk,modifiers:modifiers.includes('control')?2:0};
  for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,...params});await sleep(70);
 }
 async function closePane(){await read(`document.querySelector('#rightPane .secondary-close,#browserClose')?.click()`);await sleep(70);}
 async function measure(label,kind){const f=await read(`(()=>{const e=document.querySelector(${JSON.stringify(kind==='model'?'#composerPopover':'.ui3-inline-menu')}),r=e.getBoundingClientRect(),right=document.querySelector('#rightPane'),p=right.getBoundingClientRect(),c=document.querySelector('.composer-bar').getBoundingClientRect();return {hidden:e.hidden,left:r.left,top:r.top,right:r.right,bottom:r.bottom,w:r.width,h:r.height,sw:e.scrollWidth,cw:e.clientWidth,vw:innerWidth,vh:innerHeight,barTop:c.top,paneHidden:right.hidden,paneLeft:p.left,paneMode:right.dataset.mode,page:document.documentElement.scrollWidth}})()`);facts.push({label,kind,...f});
  check(!f.hidden&&f.left>=0&&f.top>=0&&f.right<=f.vw+1&&f.bottom<=f.vh+1&&f.sw<=f.cw+1&&f.page<=f.vw+1,label+' visible within viewport',f);
  if(kind==='slash'){
    const surfaceTop=await read(`ST.el.composerBox.getBoundingClientRect().top`);
    check(f.bottom<=surfaceTop-1,label+' menu leaves attachments and Composer actions uncovered',{...f,surfaceTop});
  }
  if(!f.paneHidden)check(f.right<=f.paneLeft+1,label+' menu avoids native/right pane',f);
 }
 try{
  fs.mkdirSync(OUT,{recursive:true});await app.whenReady();
  harness=spawn(process.execPath,[path.join(ROOT,'tests/visual-harness.cjs')],{cwd:process.env.UI3_WORLD,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',HARNESS_PORT:'0',VISUAL_PUBLIC_ROOT:process.env.UI3_ASSETS_ROOT||path.join(ROOT,'public'),VISUAL_UPLOAD_DIR:path.join(process.env.UI3_WORLD,'uploads')},stdio:['ignore','pipe','pipe'],windowsHide:true});harness.stderr.on('data',c=>errors.push(String(c)));
  const origin=await new Promise((resolve,reject)=>{let s='';const t=setTimeout(()=>reject(Error('harness timeout')),15000);harness.stdout.on('data',c=>{s+=c;const m=s.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(t);resolve(m[0]);}});harness.on('error',reject);});
  win=new BrowserWindow({width:1200,height:900,useContentSize:true,show:true,webPreferences:{preload:path.join(ROOT,'electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  browser=createBrowserController({origin,getWindow:()=>win,ipcMain});browser.register();agent=createBrowserAgentHost({browser,origin,getWindow:()=>win,ipcMain,extensionPath:path.join(ROOT,'extensions/pi-gui-browser/index.js')});await agent.start();
  win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});
  await win.loadURL(origin);await sleep(2400);
  win.show();win.focus();win.webContents.focus();win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.bringToFront');
  check(await read('document.hasFocus()'),'Chromium page has focus before trusted CDP keys');
  await read(`(async()=>{window.ST=await import('/state.js');window.C=await import('/composer.js');window.A=await import('/attachments.js');window.P=await import('/palette-model.js');window.RPC=await import('/rpc.js');window.POP=await import('/ui/popover.js');window.MSG=await import('/messages.js');
    window.calls=[];window.runs=0;const original=window.fetch;window.fetch=async(url,opts={})=>{if(url==='/api/command'){calls.push(JSON.parse(opts.body));return {ok:true,json:async()=>({ok:true})};}return original(url,opts);};
    P.defineCommands([{id:'ui3.fixture',title:'UI3 fixture command',keywords:'uniquefixture',run:()=>{runs++;}}]);
    Object.assign(ST.S,{hasProject:true,bridgeState:'ready',switching:false,modelSwitchPending:false,submitting:false,stopping:false,fallbackActive:false,attachments:[],thinkingLevels:['off','low','high'],state:{...ST.S.state,model:{provider:'alpha',id:'same',reasoning:true,input:['text','image']},thinkingLevel:'high'}});
    ST.S.models=[{provider:'alpha',id:'same',name:'Same display name',input:['text','image'],reasoning:true},{provider:'beta',id:'same',name:'Same display name',reasoning:false,input:['text']},{provider:'beta',id:'long',name:'VeryLongModelName'.repeat(12)}];
    ST.el.input.disabled=false;ST.el.composerBox.classList.remove('is-locked');C.renderModelControls();
    MSG.rebuildFromMessages(Array.from({length:16},(_,i)=>({role:i%2?'assistant':'user',content:[{type:'text',text:i===15?'联合验收末条消息':'Offline history 中文 English '.repeat(35)}]})));
    window.layoutAttachments=Array.from({length:6},(_,i)=>({id:'a'+i,name:i===0?'very-long-name'.repeat(20)+'.txt':'附件-'+i+'.txt',kind:'text',size:1234,chars:10,text:'fixture',truncated:i===1,loading:i===2,error:i===3?'解析失败':undefined}));ST.S.attachments=layoutAttachments.map(a=>({...a}));A.renderAttachments();
  })()`);
  check(await read(`['ui3-composer.css','ui3-model.css','ui3-inline-commands.css'].every(p=>[...document.styleSheets].filter(s=>s.href?.endsWith('/'+p)).length===1)`),'three styles loaded from production index exactly once');
  await input('/uniquefixture');await key('Enter');
  check(await read(`runs===1&&ST.el.input.value===''&&calls.filter(c=>['prompt','abort'].includes(c.type)).length===0`),'real Enter runs registry command once, clears token, never submits');
  await input('普通消息');await key('Enter');check(await read(`calls.filter(c=>c.type==='prompt').length===1`),'ordinary real Enter reaches original submit');
  await read(`ST.S.submitting=false;ST.S.streaming=false;C.updateSendState()`);
  await input('/uniquefixture');await key('Escape');check(await read(`document.querySelector('.ui3-inline-menu').hidden&&!calls.some(c=>c.type==='abort')&&ST.el.input.value==='/uniquefixture'`),'real Escape only closes slash and preserves draft');
  await input('/uniquefixture');await key('K',['control']);
  check(await read(`!document.querySelector('#paletteLayer').hidden&&document.querySelector('.ui3-inline-menu').hidden`),'real Ctrl+K preserves independent panel and closes slash');
  await key('Escape');
  await input('草稿');const ime=await read(`(()=>{const n=calls.length;for(const options of [{isComposing:true},{keyCode:229}])ST.el.input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,...options}));ST.el.input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));ST.el.input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));ST.el.input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));return calls.length===n})()`);check(ime,'synthetic IME signals inside real Chromium never submit (not real OS IME)');
  for(const type of ['pi-gui:session-switch','pi-gui:workspace-generation']){await input('/uniquefixture');await read(`document.dispatchEvent(new CustomEvent(${JSON.stringify(type)}))`);check(await read(`document.querySelector('.ui3-inline-menu').hidden&&ST.el.input.value==='/uniquefixture'`),type+' closes menu without draft mutation');}
  for(const view of ['planner','runtime']){await input('/uniquefixture');await read(`document.dispatchEvent(new CustomEvent('pi-gui:workspace-view',{detail:{view:${JSON.stringify(view)}}}))`);check(await read(`document.querySelector('.ui3-inline-menu').hidden&&ST.el.input.value==='/uniquefixture'`),view+' lifecycle closes menu');}
  await input('/uniquefixture');await read(`document.querySelector('#navPlanner').click()`);await sleep(100);
  check(await read(`document.querySelector('#chatComposer').hidden&&document.querySelector('.ui3-inline-menu').hidden&&ST.el.input.value==='/uniquefixture'`),'actual Planner entry closes menu with draft intact');
  await read(`document.querySelector('#navHome').click()`);await sleep(80);
  await input('/uniquefixture');await read(`(async()=>{window.SURFACE=await import('/ui/workspace-surface.js');SURFACE.showRuntimeConversation()})()`);
  check(await read(`document.querySelector('#chatComposer').hidden&&document.querySelector('.ui3-inline-menu').hidden&&ST.el.input.value==='/uniquefixture'`),'actual Runtime surface transition closes Classic menu without draft mutation');
  await read(`SURFACE.showChat()`);await sleep(80);
  await read(`document.querySelector('#btnModel').click()`);check(await read(`document.querySelectorAll('.ui3-model-item.on').length===1&&document.querySelector('.ui3-model-item.on').dataset.provider==='alpha'`),'same-name current model is paired by Provider');await key('Escape');
  for(const [reasoning,state] of [[false,'unsupported'],[null,'unknown'],[true,'unavailable']]){
    await read(`ST.S.state.model={provider:'alpha',id:'same',reasoning:${reasoning}};ST.S.thinkingLevels=[];C.renderModelControls()`);await sleep(50);await read(`document.querySelector('#btnThinkInfo').click()`);
    check(await read(`ST.el.btnThink.disabled&&!document.querySelector('#btnThinkInfo').hidden&&document.querySelector('.ui3-think-state').dataset.state===${JSON.stringify(state)}&&!document.querySelector('.ui3-think-item:not(:disabled)')`),'reachable Thinking explanation '+state);await shot('thinking-'+state);await key('Escape');
  }
  await read(`ST.S.modelSwitchPending=true;ST.S.thinkingLevels=['off','high'];C.renderModelControls()`);await sleep(50);await read(`document.querySelector('#btnThinkInfo').click()`);check(await read(`document.querySelector('.ui3-think-state').dataset.state==='pending'&&!document.querySelector('.ui3-think-item:not(:disabled)')&&ST.el.btnSend.disabled`),'pending explanation keeps real selection/send gates');await key('Escape');
  await read(`ST.S.modelSwitchPending=false;ST.S.state.model={provider:'alpha',id:'same',reasoning:true,input:['text','image']};ST.S.thinkingLevels=['off','high'];C.renderModelControls();A.renderAttachments()`);
  await input('模型回读草稿');await read(`document.querySelector('#btnModel').click();document.querySelector('.pop-provider[data-provider="beta"]').click();document.querySelector('.ui3-model-item[data-provider="beta"][data-model-id="same"]').click()`);
  check(await read(`calls.filter(c=>c.type==='set_model').length===1&&calls.find(c=>c.type==='set_model').provider==='beta'&&calls.find(c=>c.type==='set_model').modelId==='same'&&ST.S.modelSwitchPending&&ST.el.btnThink.disabled&&ST.el.btnSend.disabled`),'actual same-name click sends one correct Provider identity and pending disables controls');
  await read(`(()=>{const sent=calls.find(c=>c.type==='set_model');RPC.onResponse({command:'set_model',id:sent.id,success:false,error:'Fixture switch rejected'});ST.S.attachments.push({id:'capability-image',kind:'image',name:'capability.png',size:1,dataUrl:'data:image/png;base64,YQ=='});const st=calls.filter(c=>c.type==='get_state').at(-1),lv=calls.filter(c=>c.type==='get_available_thinking_levels').at(-1);RPC.onResponse({command:'get_state',id:st.id,success:true,data:{model:{provider:'alpha',id:'same',reasoning:false,input:['text']},thinkingLevel:'off'}});RPC.onResponse({command:'get_available_thinking_levels',id:lv.id,success:true,data:{levels:[]}});A.renderAttachments()})()`);await sleep(80);
  check(await read(`!ST.S.modelSwitchPending&&ST.S.state.model.providerId==='alpha'&&C.imageInputBlocked()&&ST.el.btnSend.disabled&&ST.el.btnThink.disabled&&!document.querySelector('#btnThinkInfo').hidden&&document.querySelector('.att[data-state="blocked"]')!==null&&ST.el.input.value==='模型回读草稿'`),'failed switch uses Pi authoritative readback for Thinking and blocked image, preserves draft');await shot('model-failure-readback');
  await read(`(()=>{RPC.refreshModelState();const st=calls.filter(c=>c.type==='get_state').at(-1),lv=calls.filter(c=>c.type==='get_available_thinking_levels').at(-1);RPC.onResponse({command:'get_state',id:st.id,success:true,data:{model:{provider:'alpha',id:'same',reasoning:true,input:['text','image']},thinkingLevel:'high'}});RPC.onResponse({command:'get_available_thinking_levels',id:lv.id,success:true,data:{levels:['off','low','high']}});A.removeAttachment('capability-image')})()`);await sleep(80);
  check(await read(`!ST.el.btnThink.disabled&&document.querySelector('#btnThinkInfo').hidden&&!C.imageInputBlocked()`),'authoritative supported model restores actual capability controls');
  await read(`ST.S.attachments=layoutAttachments.map(a=>({...a}));A.renderAttachments()`);
  check(await read(`document.querySelectorAll('.ui3-attachment-card').length===6&&!ST.el.attachTray.hidden`),'layout matrix explicitly restores six attachments after ordinary submit cleared them');
  for(const theme of ['dark','light'])for(const width of [700,900,1200,1536])for(const sidebar of [true,false])for(const pane of ['closed','changes','browser']){
    win.setContentSize(width,900);await closePane();await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector(${JSON.stringify(sidebar?'#btnSidebarExpand':'#btnSidebarCollapse')}).click()`);
    if(pane!=='closed')await read(pane==='browser'?`document.querySelector('#btnBrowser').click()`:`document.querySelector('#navChanges').click()`);
    await sleep(140);const label=`${theme}-${width}-sidebar-${sidebar}-${pane}`;
    await input(('十行 English 中文\n').repeat(9)+'/');await measure(label,'slash');await shot(label+'-slash');await key('Escape');
    await read(`(()=>{document.querySelector('#btnModel').click();const beta=document.querySelector('.pop-provider[data-provider="beta"]');if(beta.getAttribute('aria-expanded')==='false')beta.click()})()`);await measure(label,'model');await shot(label+'-model');await key('Escape');
  }
  await closePane();
  for(const zoom of [.8,1.25,1.5]){win.webContents.setZoomFactor(zoom);win.setContentSize(900,600);await sleep(150);await input(('十行中文 English\n').repeat(9)+'/');await measure('zoom-'+zoom,'slash');await shot('zoom-'+zoom+'-slash');await key('Escape');await read(`document.querySelector('#btnModel').click()`);await measure('zoom-'+zoom,'model');await shot('zoom-'+zoom+'-model');await key('Escape');}
  win.webContents.setZoomFactor(1);win.setContentSize(1200,900);await sleep(100);await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await input('/');await measure('reduced-motion','slash');await shot('reduced-motion');
  check(await read(`getComputedStyle(document.querySelector('.ui3-inline-menu')).animationName==='none'&&getComputedStyle(ST.el.composerBox).transitionDuration==='0s'&&getComputedStyle(document.querySelector('.att-spin')).animationName==='none'`),'reduced-motion actually disables menu, Composer and loading spinner motion');
  check(errors.length===0,'no renderer or harness errors',errors);
 }catch(e){check(false,'joint fixture completed',e.stack);}
 finally{clearTimeout(timeout);const failed=checks.filter(c=>!c.pass).length;fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify({passed:checks.length-failed,failed,skipped:0,exitCode:failed?1:0,checks,facts,screenshots,errors,durationMs:Date.now()-start,versions:{electron:process.versions.electron,chromium:process.versions.chrome},limits:'Production app/index styles and handlers, offline fixture HTTP, sandbox enabled; capturePage only web pixels. Composition synthetic, no OS IME or real model. Lifecycle events injected, not real Pi switching.'},null,2));console.log(`UI3 joint Electron ${checks.length-failed}/${checks.length}; failed=${failed}; skipped=0`);await agent?.stop?.();browser?.destroy?.();win?.destroy();harness?.kill();await sleep(150);app.exit(failed?1:0);}
}
