/* Offline visual audit: real electron/main.cjs, preload, production public ESM,
 * native Browser controller. Only the backend is the owned visual fixture.
 * capturePage images exclude OS decoration; native captures are separate. */
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
const OUT=path.resolve(process.env.UI5_VISUAL_OUT||path.join(ROOT,'docs/claude-ui-redesign/ui5-visual-evidence/latest'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
if(!process.versions.electron) main().catch(e=>{console.error(e);process.exitCode=1;}); else desktop();
async function main(){
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'ui5-final-'));let harness,proxy,preview,child;
 fs.mkdirSync(OUT,{recursive:true});
 try{
  harness=spawn(process.execPath,[path.join(ROOT,'tests/visual-harness.cjs')],{cwd:world,env:{...process.env,HARNESS_PORT:'0',VISUAL_PUBLIC_ROOT:process.env.UI5_ASSETS_ROOT||path.join(ROOT,'public'),VISUAL_UPLOAD_DIR:path.join(world,'uploads')},stdio:['ignore','pipe','pipe'],windowsHide:true});
  harness.stderr.on('data',b=>process.stderr.write(b));
  const origin=await new Promise((resolve,reject)=>{let s='';const t=setTimeout(()=>reject(Error('harness timeout')),20000);harness.stdout.on('data',b=>{s+=b;const m=s.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(t);resolve(m[0]);}});harness.on('error',reject);});
  // Main's ordinary backend-reuse path verifies these identity fields. No
  // authentication/security claim is inferred from this fixture backend.
  proxy=http.createServer((req,res)=>{
   if(req.url==='/api/health'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({app:'pi-gui',protocol:1,version:require('../package.json').version}));return;}
   if(req.url==='/api/processes'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,generation:'visual',enabled:false,available:true,cleanupPending:false,processes:[]}));return;}
   if(req.url.startsWith('/api/session-revert/query')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,target:{conversationId:'classic-chat'},capture:{enabled:true},operationCount:0,fileCount:0,evidenceComplete:false,attributionGap:true,expired:false,previewEligible:false,revision:1,files:[]}));return;}
   const upstream=http.request(origin+req.url,{method:req.method,headers:{...req.headers,host:new URL(origin).host}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);res.on('close',()=>upstream.destroy());
  });
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  preview=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end('<!doctype html><title>Offline preview</title><body style="font:16px system-ui;background:#fcfcfb;color:#151515;padding:24px"><h1>Local preview</h1><p>Native WebContentsView · offline fixture</p></body>');});await new Promise(r=>preview.listen(0,'127.0.0.1',r));
  const env={...process.env,UI5_VISUAL_WORLD:world,UI5_VISUAL_OUT:OUT,UI5_PREVIEW_URL:'http://127.0.0.1:'+preview.address().port,PORT:String(proxy.address().port),PI_GUI_DATA:path.join(world,'data'),PI_GUI_LOG_DIR:path.join(world,'logs')};delete env.ELECTRON_RUN_AS_NODE;
  child=spawn(require('electron'),[__filename,'--user-data-dir='+path.join(world,'user-data')],{cwd:ROOT,env,stdio:'inherit',windowsHide:true});
  process.exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',c=>resolve(c??1));});
 }finally{harness?.kill();proxy?.closeAllConnections();proxy?.close();preview?.closeAllConnections();preview?.close();try{fs.rmSync(world,{recursive:true,force:true,maxRetries:30,retryDelay:100});}catch(e){console.error('fixture cleanup '+e.code);}}
}
function desktop(){
 const {app,BrowserWindow}=require('electron');
 app.setPath('userData',path.join(process.env.UI5_VISUAL_WORLD,'user-data'));
 const checks=[],shots=[],facts=[],errors=[];let win;
 const read=s=>win.webContents.executeJavaScript(s,true);
 const check=(pass,name,detail)=>{checks.push({pass:!!pass,name,detail});console.log((pass?'PASS ':'FAIL ')+name+(pass?'':' '+JSON.stringify(detail)));};
 const until=async fn=>{for(let i=0;i<200;i++){if(await fn())return;await sleep(60);}throw Error('timeout '+fn);};
 const click=id=>read(`document.getElementById(${JSON.stringify(id)}).click()`);
 const key=async name=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:name});win.webContents.sendInputEvent({type:'keyUp',keyCode:name});await sleep(120);};
 async function shot(name){await sleep(220);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());shots.push(name+'.png');
  const f=await read(`(()=>{const r=s=>{const e=document.querySelector(s);if(!e||e.hidden)return null;const b=e.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}};return {w:innerWidth,h:innerHeight,dpr:devicePixelRatio,theme:document.documentElement.dataset.theme,pageWidth:document.documentElement.scrollWidth,sidebar:r('#projectSidebar'),thread:r('.thread'),composer:r('#composerBox'),input:r('#input'),bar:r('.composer-bar'),pane:r('#rightPane'),title:r('.stage-head'),popover:r('#composerPopover'),font:getComputedStyle(document.body).fontFamily}})()`);
  facts.push({name,zoom:win.webContents.getZoomFactor(),contentSize:win.getContentSize(),...f});check(f.pageWidth<=f.w+1,name+' no horizontal page overflow',f);
  if(process.env.UI5_EXPECT_POLISH!=='0' && name==='dark-1200-changes')check(await read(`document.querySelector('.stage-head h1').getBoundingClientRect().width>=48`),'opening Changes retains a readable session title');
  if(process.env.UI5_EXPECT_POLISH!=='0' && name==='dark-1200-empty')check(await read(`document.querySelector('#welcomeReady h2').getBoundingClientRect().top<=110`),'empty conversation starts at the top of the reading axis');
 }
 const closeModal=()=>key('Escape');
 const closePane=()=>read(`document.querySelector('#rightPaneClose,#browserClose')?.click()`);
 const draft=async text=>{await read(`(()=>{const e=document.getElementById('input');e.value=${JSON.stringify(text)};e.focus();e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await sleep(100);};
 async function captureNative(name){
  win.setAlwaysOnTop(true);win.show();win.focus();win.moveTop();await sleep(400);
  const child=spawn('powershell.exe',['-NoProfile','-File',path.join(ROOT,'tests/ui5-native-window.ps1'),'-WindowHandle',win.getNativeWindowHandle().readBigUInt64LE().toString(),'-ExpectedPid',String(process.pid),'-OutputFile',path.join(OUT,name+'.png')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let result='';child.stdout.on('data',b=>result+=b);child.stderr.on('data',b=>result+=b);const code=await new Promise(r=>child.on('exit',r));facts.push({nativeCapture:name,exitCode:code,result:result.trim(),contentSize:win.getContentSize(),bounds:win.getBounds()});win.setAlwaysOnTop(false);
 }
 async function run(){
  await until(()=>read(`Boolean(document.getElementById('btnModel')&&document.querySelector('.pj-sess'))`));await sleep(2200);
  check(win.webContents.getLastWebPreferences().sandbox===true,'production main keeps sandbox');
  check(win.webContents.getLastWebPreferences().contextIsolation===true,'production main keeps context isolation');
  win.webContents.debugger.attach('1.3');
  await read(`(async()=>{window.VF={M:await import('/messages.js'),T:await import('/tools.js'),ST:await import('/state.js'),A:await import('/attachments.js')};})()`);
  await read(`VF.M.clearThread();VF.ST.S.switching=false`);
  win.setContentSize(1200,900);await shot('dark-1200-empty');
  await click('btnSidebarCollapse');await shot('dark-1200-collapsed');await click('btnSidebarExpand');
  const prose='已检查现有组件。\n\n### 核对结果\n\n- 保留真实状态和错误信息\n- 使用相同阅读轴和输入区\n\n'+String.fromCharCode(96).repeat(3)+'js\nconst ready = true;\nconsole.log(ready);\n'+String.fromCharCode(96).repeat(3)+'\n\n英文与中文都应清晰可读。';
  await read(`(()=>{const text=${JSON.stringify(prose)};VF.M.onMessageStart({message:{role:'user',content:'请检查布局，同时保留全部功能。'}});VF.M.onMessageStart({message:{role:'assistant'}});VF.M.onMessageUpdate({assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:text}});VF.M.onMessageEnd({message:{role:'assistant',content:[{type:'text',text}]}});})()`);
  await shot('dark-1200-history');
  await win.webContents.debugger.sendCommand('DOM.enable');await win.webContents.debugger.sendCommand('CSS.enable');
  const doc=await win.webContents.debugger.sendCommand('DOM.getDocument');
  const node=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'.msg.assistant .assistant-text p'});
  facts.push({platformFonts:await win.webContents.debugger.sendCommand('CSS.getPlatformFontsForNode',{nodeId:node.nodeId})});
  await read(`(()=>{for(let i=0;i<4;i++){VF.T.onToolStart({toolCallId:'audit-'+i,toolName:i===3?'bash':'read',args:i===3?{command:'node fixture-check.cjs'}:{path:'src/layout-'+i+'.js'}});VF.T.onToolEnd({toolCallId:'audit-'+i,result:{content:[{type:'text',text:i===3?'Command exited with code 1\\nFixture validation failed':'Fixture source text'}]},isError:i===3});}})()`);
  await shot('dark-1200-tools');
  if(process.env.UI5_EXPECT_POLISH!=='0'){
   const target=await read(`(()=>{const c=document.querySelector('#composerBox').getBoundingClientRect(),i=document.querySelector('#input').getBoundingClientRect(),b=document.querySelector('.composer-bar').getBoundingClientRect(),send=document.querySelector('#btnSend').getBoundingClientRect(),sidebar=document.querySelector('#projectSidebar').getBoundingClientRect(),g=getComputedStyle(document.querySelector('.tl-group'));return {c:c.height,i:i.height,toolbarTop:b.top,inputTop:i.top,inputBottom:i.bottom,sendTop:send.top,sendBottom:send.bottom,leftWidth:sidebar.right,rowHeight:document.querySelector('.pj-sess').getBoundingClientRect().height,bg:g.backgroundColor}})()`);
   check(target.c<=88&&target.i>=36&&target.toolbarTop>=target.inputBottom&&target.sendTop>=target.inputTop&&target.sendBottom<=target.inputBottom,'compact input keeps Send inside its surface and toolbar below',target);
   check(Math.abs(target.leftWidth-288)<=1&&target.rowHeight<=31&&target.rowHeight>=24,'wide navigation leaves reference-sized space with usable compact rows',target);
   check(target.bg==='rgba(0, 0, 0, 0)','tool group has an open surface while retaining result rows',target);
  }
  await draft('请继续核对 Composer');await shot('dark-1200-input');
  await read(`VF.ST.S.attachments=[{id:'visual-file',name:'layout-notes.txt',kind:'text',chars:42,text:'Temporary fixture content',size:42}];VF.A.renderAttachments()`);await shot('dark-1200-attachment');
  await read(`VF.A.removeAttachment('visual-file')`);
  check(await read(`document.getElementById('input').value==='请继续核对 Composer' && VF.ST.S.attachments.length===0`),'attachment removal preserves actual draft');
  await click('btnModel');await shot('dark-1200-model');await key('Escape');
  check(await read(`document.activeElement?.id==='btnModel' && document.getElementById('composerPopover').hidden`),'model Escape closes and restores trigger focus');
  await click('btnThink');await shot('dark-1200-thinking');await key('Escape');
  await draft('/');await shot('dark-1200-slash');
  if(process.env.UI5_EXPECT_POLISH!=='0')check(await read(`(()=>{const w=document.querySelector('.ui3-inline-menu').getBoundingClientRect().width;return w>=200&&w<=360})()`),'Slash stays a compact command list instead of filling the reading column');
  await key('Escape');await draft('');
  await click('navChanges');await sleep(450);await shot('dark-1200-changes');await closePane();
  await click('btnBrowser');await sleep(650);await shot('dark-1200-browser');
  await read(`(()=>{const e=document.getElementById('browserAddress');e.value=${JSON.stringify(process.env.UI5_PREVIEW_URL)};e.focus();})()`);await key('Enter');await sleep(600);await shot('dark-1200-browser-preview');
  await captureNative('native-dark-browser');
  check(win.contentView.children.some(v=>v.webContents&&v.webContents!==win.webContents),'production native Browser WebContentsView attached');
  await read(`(async()=>{const m=await import('/ui/modal.js');m.openModal(card=>{const p=document.createElement('p');p.textContent='离线 fixture：模态层覆盖原生 Browser';card.append(p);});})()`);await sleep(300);await shot('dark-1200-browser-modal');
  await captureNative('native-dark-browser-modal');
  check(!win.contentView.children.some(v=>v.webContents&&v.webContents!==win.webContents),'modal detaches native Browser');await closeModal();await closePane();
  await read(`(async()=>{const p=await import('/process-panel.js');p.openProcessPanel();})()`);await sleep(350);await shot('dark-1200-processes');await closePane();
  await read(`(async()=>{const p=await import('/session-changes-panel.js');p.openSessionChangesPanel();})()`);await sleep(350);await shot('dark-1200-session-changes');await closePane();
  await click('navGlobalMore');await shot('dark-1200-settings');await key('Escape');
  await click('navDiagnostics');await sleep(250);await shot('dark-1200-diagnostics');await key('Escape');
  await click('navLogs');await sleep(300);await shot('dark-1200-logs');await key('Escape');
  await read(`(async()=>{const a=await import('/approval.js');a.observeApprovalEvent({type:'extension_ui_request',id:'visual-audit',method:'confirm',title:'执行离线 fixture 核对',message:'node fixture-check.cjs --inspect\\n需要读取临时项目；风险未知，不推断命令安全。'},VF.ST.S);})()`);await shot('dark-1200-approval');await key('Escape');
  win.setContentSize(1300,889);await shot('dark-1300-reference');
  await read(`VF.M.clearThread();fetch('/api/__conversation?what=fixture')`);await sleep(800);await shot('dark-1300-long-conversation');
  await captureNative('native-dark-1300');
  for(const theme of ['dark','light'])for(const width of [700,900,1200,1536]){
   win.webContents.setZoomFactor(1);win.setContentSize(width,900);await read(`(async()=>{await (await import('/theme.js')).setThemePreference(${JSON.stringify(theme)});})()`);
   await draft('');await shot(theme+'-'+width+'-expanded');
   await click('btnSidebarCollapse');await shot(theme+'-'+width+'-collapsed');
   await draft(('多行输入 English 中文 — 保留草稿和发送屏障。\n').repeat(7));await shot(theme+'-'+width+'-multiline');
   await click('navChanges');await sleep(180);await shot(theme+'-'+width+'-pane');await closePane();await click('btnSidebarExpand');
   await click('navChanges');await sleep(180);await shot(theme+'-'+width+'-expanded-pane');await closePane();
  }
  for(const theme of ['dark','light'])for(const zoom of [.8,1.25,1.5]){await read(`(async()=>{await (await import('/theme.js')).setThemePreference(${JSON.stringify(theme)});})()`);win.setContentSize(1200,900);win.webContents.setZoomFactor(zoom);await draft('缩放下的输入状态');await shot(theme+'-zoom-'+zoom+'-composer');await click('btnModel');await shot(theme+'-zoom-'+zoom+'-model');await key('Escape');}
  win.webContents.setZoomFactor(1);win.setContentSize(1200,900);await captureNative('native-light-1200');
  await read(`(async()=>{await (await import('/theme.js')).setThemePreference('dark');await fetch('/api/__composer-models',{method:'POST'});})()`);await sleep(400);
  for(const width of [700,900]){
   win.setContentSize(width,700);await draft('');await sleep(200);
   await read(`window.__visualComposerBefore=document.querySelector('#composerBox').getBoundingClientRect().toJSON();document.getElementById('btnModel').click();document.querySelectorAll('.pop-model-group').forEach(g=>{if(g.dataset.provider!=='deepseek'&&g.firstElementChild.getAttribute('aria-expanded')==='true')g.firstElementChild.click()});document.querySelector('[data-provider="openrouter"] .pop-provider').click()`);
   await shot('dark-'+width+'-many-models');
   const geometry=await read(`(()=>{const p=document.getElementById('composerPopover'),r=p.getBoundingClientRect(),c=document.querySelector('#composerBox').getBoundingClientRect(),b=window.__visualComposerBefore;return {bounded:r.top>=8&&r.left>=8&&r.right<=innerWidth-8&&r.bottom<=innerHeight-8,stable:['x','y','width','height'].every(k=>Math.abs(c[k]-b[k])<.5),scroll:p.scrollHeight>p.clientHeight&&p.scrollWidth<=p.clientWidth,rect:r.toJSON()}})()`);
   check(geometry.bounded&&geometry.stable&&geometry.scroll,'expanded hundred-model provider stays bounded without moving Composer at '+width,geometry);await key('Escape');
  }
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  check(await read(`matchMedia('(prefers-reduced-motion:reduce)').matches`),'real Chromium reduced motion enabled');
 }
 const timer=setTimeout(()=>{console.error('visual timeout');app.exit(1);},240000);
 app.on('browser-window-created',(_e,w)=>{if(win)return;win=w;w.webContents.on('console-message',(_e,level,message)=>{if(level>=3&&!/Electron Security Warning/.test(message))errors.push(String(message));});w.webContents.once('did-finish-load',()=>run().catch(e=>{errors.push(e.stack);console.error(e);}).finally(()=>{clearTimeout(timer);const result={entry:'electron/main.cjs',fixture:'offline visual-harness behind identity proxy; no real Pi or project',passed:checks.filter(c=>c.pass).length,failed:checks.filter(c=>!c.pass).length,checks,shots,facts,errors};fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify(result,null,2));console.log('UI5 visual '+result.passed+'/'+checks.length+' errors='+errors.length);app.exit(result.failed||errors.length?1:0);}));});
 require('../electron/main.cjs');
}
