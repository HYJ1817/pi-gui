'use strict';
// Design evidence only. Production renderer/main, owned offline visual fixture.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../../..'),OUT=path.resolve(process.env.DESIGN_PRODUCTION_OUTPUT||path.join(__dirname,'../evidence/production-refined-verified'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
if(!process.versions.electron) parent().catch(e=>{console.error(e);process.exitCode=1});else desktop();
async function parent(){
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-design-current-')); fs.mkdirSync(OUT,{recursive:true});let harness,proxy,browserPage;
 try{
 harness=spawn(process.execPath,[path.join(ROOT,'tests/visual-harness.cjs')],{cwd:world,env:{...process.env,HARNESS_PORT:'0',VISUAL_PUBLIC_ROOT:path.join(ROOT,'public'),VISUAL_UPLOAD_DIR:path.join(world,'uploads')},stdio:['ignore','pipe','pipe'],windowsHide:true});
 harness.stderr.on('data',b=>process.stderr.write(b));
 const origin=await new Promise((resolve,reject)=>{let s='';const timer=setTimeout(()=>reject(Error('fixture timeout')),20000);harness.stdout.on('data',b=>{s+=b;const m=s.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}})});
 proxy=http.createServer((req,res)=>{
 if(req.url==='/api/health'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({app:'pi-gui',protocol:1,version:require(path.join(ROOT,'package.json')).version}));}
 if(req.url==='/api/processes'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true,generation:'design',enabled:false,available:true,cleanupPending:false,processes:[]}));}
 const up=http.request(origin+req.url,{method:req.method,headers:{...req.headers,host:new URL(origin).host}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});up.on('error',()=>{res.writeHead(502);res.end()});req.pipe(up);res.on('close',()=>up.destroy());
 });await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 browserPage=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end('<!doctype html><title>Refined Offline Browser</title><style>html{background:#f5f5f5;color:#242424;font:16px Segoe UI}body{padding:24px}</style><h1>Offline Browser fixture</h1><input id=fixtureDraft>');});await new Promise(r=>browserPage.listen(0,'127.0.0.1',r));
 const env={...process.env,DESIGN_BROWSER_PORT:String(browserPage.address().port),DESIGN_CURRENT_WORLD:world,DESIGN_CAPTURE_SUPPLEMENT:process.argv.includes('--supplement')?'1':'0',PORT:String(proxy.address().port),PI_GUI_DATA:path.join(world,'data'),PI_GUI_LOG_DIR:path.join(world,'logs')};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(require('electron'),[__filename,'--user-data-dir='+path.join(world,'user-data')],{cwd:ROOT,env,stdio:'inherit',windowsHide:true});
 process.exitCode=await new Promise((r,j)=>{child.on('error',j);child.on('exit',c=>r(c??1))});
 }finally{harness?.kill();browserPage?.closeAllConnections();browserPage?.close();proxy?.closeAllConnections();proxy?.close();console.log('Fixture retained in TEMP: '+world);}
}
function desktop(){
 const {app}=require('electron');app.setPath('userData',path.join(process.env.DESIGN_CURRENT_WORLD,'user-data'));let win;const shots=[],observations=[],errors=[],checks=[],nativeEvidence={};
 const read=s=>win.webContents.executeJavaScript(s);
 const click=async id=>{const point=await read(`(()=>{const e=document.getElementById(${JSON.stringify(id)});if(!e||e.closest('[hidden]'))throw Error('hidden target '+${JSON.stringify(id)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);const z=win.webContents.getZoomFactor();for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,x:Math.round(point.x*z),y:Math.round(point.y*z),button:'left',clickCount:1});await sleep(180)};
 const check=async(name,expr)=>{const ok=await read(expr);checks.push({name,ok:ok===true});if(ok!==true)throw Error(name+': '+JSON.stringify(ok));console.log('PASS '+name)};
 const key=async k=>{win.focus();win.webContents.focus();win.webContents.sendInputEvent({type:'keyDown',keyCode:k});win.webContents.sendInputEvent({type:'keyUp',keyCode:k});await sleep(160)};
 const shot=async name=>{win.show();win.focus();await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await sleep(180);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());shots.push(name+'.png');observations.push({name,...await read(`(()=>{const r=s=>{const e=document.querySelector(s);if(!e||e.hidden)return null;return e.getBoundingClientRect().toJSON()};return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,pageWidth:document.documentElement.scrollWidth,sidebar:r('#projectSidebar'),composer:r('#composerBox'),panel:r('#rightPane'),popover:r('#composerPopover'),active:document.activeElement?.id,text:document.body.innerText.slice(0,10000)}})()`)});console.log('Captured '+name)};
 async function nativeInputHold(){
 win.setTitle('Refined Native IME · offline fixture');
 await read(`(()=>{document.title='Refined Native IME · offline fixture';const e=document.getElementById('input');e.value='';e.focus();window.qaNativeInput={events:[],requests:0};for(const type of ['compositionstart','compositionupdate','compositionend','keydown','input'])e.addEventListener(type,x=>{window.qaNativeInput.events.push({type:x.type,key:x.type==='keydown'?x.key:undefined,composing:x.isComposing===true,length:e.value.length})});const prior=window.fetch;window.fetch=(url,options)=>{try{if(typeof options?.body==='string'&&JSON.parse(options.body).type==='prompt')window.qaNativeInput.requests++}catch{}return prior(url,options)};return true})()`);
 fs.writeFileSync(path.join(OUT,'native-input-ready.json'),JSON.stringify({pid:process.pid,title:'Refined Native IME · offline fixture',fixture:'TEMP offline visual backend; native OS keyboard automation, not paid model or user session'}));
 while(!fs.existsSync(path.join(OUT,'native-input-finish.flag'))){
  const state=await read(`(()=>{const e=document.getElementById('input');return {...window.qaNativeInput,length:e.value.length,matchesChineseFixture:e.value==='你好',dpr:devicePixelRatio,zoom:visualViewport.scale,active:document.activeElement?.id}})()`);
  fs.writeFileSync(path.join(OUT,'native-input-state.json'),JSON.stringify(state,null,2));await sleep(300);
 }
 await shot('native-input-final');
 }
 async function completionSettings(){
 const destinations=['navProviders','navProviderAuth','navAppUpdates','navDiagnostics','navLogs','navAppearance','navShortcutHelp'];
 await read(`(()=>{window.qaBaseFetch=window.fetch;window.fetch=(url,options)=>window.qaBaseFetch(url,options).then(async response=>{if(String(url)!=='/api/providers')return response;const data=await response.json();data.path='C:\\\\fixture\\\\agent\\\\models.json';return {ok:response.ok,status:response.status,json:async()=>data}});return true})()`);
 await read(`document.getElementById('input').value='设置详情往返 · 离线fixture草稿'`);
 for(const theme of ['dark','light'])for(const [width,height] of [[1280,800],[1440,900],[1920,1080]]){
  win.setContentSize(width,height);await read(`(async()=>{await (await import('/theme.js')).setThemePreference(${JSON.stringify(theme)})})()`);
  await click('navGlobalMore');
  for(const id of destinations){
   await click(id);await sleep(200);
   await check(theme+'/'+width+'/'+id+' central isolated page',`document.getElementById('modal').hidden&&document.querySelector('.settings-detail-card')?.getAttribute('role')==='region'&&document.getElementById(${JSON.stringify(id)}).getAttribute('aria-current')==='page'`);
   await check(theme+'/'+width+'/'+id+' fits viewport',`(()=>{const e=document.querySelector('.settings-detail-card'),r=e.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&r.left>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&e.scrollWidth<=e.clientWidth+1})()`);
   await shot(theme+'-'+width+'-'+id);
   if(id==='navProviders'){
    await read(`([...document.querySelectorAll('.settings-detail-card button')].find(b=>b.textContent==='添加供应商')).id='qaAddProvider'`);await click('qaAddProvider');
    await check(theme+'/'+width+' provider form owns page',`document.querySelectorAll('.settings-detail-card .preset').length===9&&document.getElementById('modal').hidden`);await shot(theme+'-'+width+'-provider-form');
   }
   await key('Tab');await check(theme+'/'+width+'/'+id+' keyboard reaches page',`Boolean(document.activeElement.closest('.settings-detail-card'))`);
   await key('Escape');await check(theme+'/'+width+'/'+id+' Escape returns settings',`Boolean(document.querySelector('.settings-section'))&&document.getElementById('modal').hidden`);
  }
  await click('settingsReturn');await check(theme+'/'+width+' details retain chat draft',`document.getElementById('input').value.includes('离线fixture草稿')`);
 }
 win.setContentSize(1440,900);
 await read(`window.qaOriginalFetch=window.fetch;window.fetch=(url,options)=>String(url)==='/api/providers'&&!options?.body?Promise.resolve({ok:true,json:async()=>({ok:false,error:'离线fixture：供应商读取失败，请重试。'})}):window.qaOriginalFetch(url,options);true`);
 await click('navGlobalMore');await click('navProviders');await check('provider error feedback',`document.querySelector('.settings-detail-card').textContent.includes('供应商读取失败')`);await shot('light-1440-provider-error');
 await read(`window.fetch=window.qaOriginalFetch;document.querySelector('.settings-detail-card .hint-empty button').id='qaProviderRetry'`);await click('qaProviderRetry');await check('provider retry recovers current page',`!document.querySelector('.settings-detail-card').textContent.includes('供应商读取失败')`);
 for(const zoom of [1.25,1.5,2]){win.webContents.setZoomFactor(zoom);await click('navAppearance');await check('settings page zoom '+zoom+' fits',`(()=>{const e=document.querySelector('.settings-detail-card');return document.documentElement.scrollWidth<=innerWidth&&e.scrollWidth<=e.clientWidth+1})()`);await shot('light-1440-settings-zoom-'+zoom)}
 win.webContents.setZoomFactor(1);await click('settingsReturn');
 }
 async function nativeCheck(){
 await click('btnWorkPanel');await click('btnBrowser');await sleep(400);
 await click('browserAddress');await read(`document.getElementById('browserAddress').value='http://127.0.0.1:${process.env.DESIGN_BROWSER_PORT}/qa-browser'`);await read(`document.getElementById('browserAddress').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);nativeEvidence.addressInput='DOM keydown dispatched to the existing field handler';
 let native;
 for(let i=0;i<80;i++){native=win.contentView.children.find(v=>v.webContents);if(native?.webContents.getTitle()==='Refined Offline Browser')break;await sleep(100)}
 if(!native||native.webContents.getTitle()!=='Refined Offline Browser')throw Error('Native Browser loopback navigation not confirmed');checks.push({name:'native Browser actually loads local fixture',ok:true});
 nativeEvidence.matrix=[];
 for(const [width,height,zoom] of [[1280,800,1],[1440,900,1],[1920,1080,1],[760,820,1],[1440,900,1.25],[1440,900,1.5]]){
  win.setContentSize(width,height);win.webContents.setZoomFactor(zoom);let row;
  for(let i=0;i<60;i++){await sleep(50);const r=await read(`document.getElementById('browserViewport').getBoundingClientRect().toJSON()`);const bounds=native.getBounds();row={width,height,zoom,viewport:r,bounds,mode:await read(`document.getElementById('rightPane').dataset.mode`)};if(['x','y','width','height'].every(k=>Math.abs(bounds[k]-r[k]*zoom)<=1))break;}
  const ok=['x','y','width','height'].every(k=>Math.abs(row.bounds[k]-row.viewport[k]*zoom)<=1);checks.push({name:'native geometry '+width+' zoom '+zoom,ok});if(!ok)throw Error('native geometry mismatch');nativeEvidence.matrix.push(row);await shot('native-'+width+'-zoom-'+zoom);
 }
 win.setContentSize(1440,900);win.webContents.setZoomFactor(1);await sleep(250);
 await native.webContents.executeJavaScript(`document.getElementById('fixtureDraft').value='owned fixture draft'`);
 await read(`(async()=>{(await import('/ui/modal.js')).openModal(card=>{card.textContent='离线 fixture：验证原生页不会遮挡对话框'})})()`);await sleep(200);checks.push({name:'modal detaches actual native page',ok:win.contentView.children.length===0});await shot('native-modal-occlusion');
 await read(`(async()=>{(await import('/ui/modal.js')).closeModal()})()`);await sleep(250);checks.push({name:'modal return preserves native form and attachment',ok:win.contentView.children.includes(native)&&await native.webContents.executeJavaScript(`document.getElementById('fixtureDraft').value==='owned fixture draft'`)});
 nativeEvidence.version=process.versions.electron;
 nativeEvidence.title=native.webContents.getTitle();nativeEvidence.bounds=native.getBounds();
 const viewport=await read(`document.getElementById('browserViewport').getBoundingClientRect().toJSON()`);
 nativeEvidence.viewport=viewport;nativeEvidence.zoom=win.webContents.getZoomFactor();
 checks.push({name:'native Browser geometry matches renderer',ok:['x','y','width','height'].every(k=>Math.abs(nativeEvidence.bounds[k]-viewport[k]*nativeEvidence.zoom)<=1)});
 await shot('light-1440-native-browser-shell');
 try{const png=await native.webContents.capturePage();fs.writeFileSync(path.join(OUT,'native-browser-page.png'),png.toPNG());nativeEvidence.pageCapture='captured';}
 catch(error){nativeEvidence.pageCapture='failed';nativeEvidence.captureError=error.message;console.log('Native screenshot limitation: '+error.message)}
 await click('navGlobalMore');checks.push({name:'settings detaches native Browser',ok:win.contentView.children.length===0});await shot('light-1440-settings-after-native');await click('settingsReturn');
 }
 async function supplement(){
 await read(`fetch('/api/__conversation?what=fixture')`);await sleep(600);
 for(const theme of ['dark','light'])for(const [width,height] of [[1280,800],[1440,900],[1920,1080]]){
  win.setContentSize(width,height);await read(`(async()=>{await (await import('/theme.js')).setThemePreference(${JSON.stringify(theme)})})()`);
  await click('btnWorkPanel');await click('navChanges');await sleep(200);
  await read(`document.querySelector('#rightPane .chg-main').id='qaDiffRow'`);if(await read(`document.querySelector('#rightPane .chg-diff')?.hidden===true`))await click('qaDiffRow');await sleep(350);
  await check(theme+'/'+width+' actual Diff opens',`document.querySelector('#rightPane .chg-diff')?.hidden===false`);await shot(theme+'-'+width+'-diff');await click('rightPaneClose');
 }
 win.setContentSize(1440,900);await read(`(async()=>{await (await import('/theme.js')).setThemePreference('dark')})()`);
 await read(`(()=>{VF.M.clearThread();VF.ST.el.title.textContent='运行与失败状态 · 离线fixture';VF.M.onMessageStart({message:{role:'user',content:'检查测试输出，告诉我当前执行状态。'}});VF.M.setStreaming(true);VF.M.onMessageStart({message:{role:'assistant'}});VF.M.onMessageUpdate({assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'正在检查定向回归。工具输出会保留在本次活动中。'}});VF.T.onToolStart({toolCallId:'qa-running',toolName:'bash',args:{command:'node --test tests/offline-fixture.cjs'}});})()`);
 await check('running composer exposes real Stop control',`!document.getElementById('btnStop').hidden`);await shot('dark-1440-agent-running');
 await read(`(()=>{VF.T.onToolEnd({toolCallId:'qa-running',isError:true,result:{content:[{type:'text',text:'Offline fixture: one expected check failed; no real command was executed.'}]}});VF.M.setStreaming(false);VF.M.onSettled();})()`);
 await check('failed tool keeps explicit error state',`document.querySelector('.tl-item[data-status="error"]')!==null`);await shot('dark-1440-tool-error');
 await click('btnModel');await read(`document.querySelector('.ui3-model-search').id='qaModelSearch'`);await click('qaModelSearch');win.webContents.insertText('Flash');await sleep(200);
 await check('native typed model query filters actual menu',`(()=>{const rows=[...document.querySelectorAll('.ui3-model-item')].filter(e=>!e.closest('[hidden]'));return rows.length===1&&rows[0].textContent.includes('Flash')})()`);await shot('dark-1440-model-search');
 win.webContents.insertText(' unavailable-fixture');await sleep(200);await check('native typed missing model has empty feedback',`!document.querySelector('.ui3-model-no-match').hidden`);await shot('dark-1440-model-search-empty');await key('Escape');
 }
 async function run(){
 for(let i=0;i<100;i++){if(await read(`Boolean(document.getElementById('btnModel')&&document.querySelector('.pj-sess'))`))break;await sleep(120)}await sleep(1200);
 await read(`(async()=>{window.VF={M:await import('/messages.js'),T:await import('/tools.js'),ST:await import('/state.js')};await (await import('/theme.js')).setThemePreference('dark');VF.M.clearThread();VF.ST.S.switching=false})()`);
 win.setContentSize(1440,900);await shot('dark-1440-empty');if(process.env.DESIGN_NATIVE_INPUT_ONLY==='1'){await nativeInputHold();return;}if(process.env.DESIGN_SETTINGS_ONLY==='1'){await completionSettings();return;}if(process.env.DESIGN_NATIVE_ONLY==='1'){await nativeCheck();return;}if(process.env.DESIGN_CAPTURE_SUPPLEMENT==='1'){await supplement();return;}
 await read(`fetch('/api/__conversation?what=fixture')`);await sleep(650);
 await read(`window.refinedChat=document.getElementById('chatView');document.getElementById('input').value='本地 fixture 草稿：检查设置往返';document.getElementById('input').dispatchEvent(new Event('input',{bubbles:true}));`);
 for(const theme of ['dark','light'])for(const [width,height] of [[1280,800],[1440,900],[1920,1080]]){
  win.setContentSize(width,height);await read(`(async()=>{await (await import('/theme.js')).setThemePreference(${JSON.stringify(theme)})})()`);
  await shot(theme+'-'+width+'-chat');
  await check(theme+'/'+width+' no page overflow',`document.documentElement.scrollWidth<=innerWidth`);
  await check(theme+'/'+width+' sidebar single column',`document.getElementById('globalRail').hidden&&Math.abs(document.getElementById('projectSidebar').getBoundingClientRect().width-(innerWidth>900?264:224))<1`);
  await click('btnModel');await shot(theme+'-'+width+'-model');
  await check(theme+'/'+width+' menu in viewport',`(()=>{const r=document.getElementById('composerPopover').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`);await key('Escape');await check(theme+'/'+width+' Escape closes model menu',`document.getElementById('composerPopover').hidden`);
  await click('btnWorkPanel');await shot(theme+'-'+width+'-panel-launcher');await click('navChanges');await sleep(300);await check(theme+'/'+width+' Changes is mounted',`document.getElementById('rightPane').dataset.surface==='changes'`);await shot(theme+'-'+width+'-changes');
  await click('rightPaneClose');await check(theme+'/'+width+' pane close focus',`document.activeElement.id==='btnWorkPanel'`);
  await click('navGlobalMore');await shot(theme+'-'+width+'-settings');await click('navPlanner');await sleep(200);await shot(theme+'-'+width+'-tasks');
  await click('settingsReturn');await check(theme+'/'+width+' chat draft retained',`document.getElementById('chatView')===window.refinedChat&&document.getElementById('input').value.includes('fixture')`);
 }
 win.setContentSize(1440,900);
 await click('navGlobalMore');await click('navExtensions');await sleep(300);await shot('light-1440-extensions');await click('navProviders');await sleep(300);await shot('light-1440-provider-dialog');await key('Escape');await click('settingsReturn');
 await read(`document.getElementById('input').value='/';document.getElementById('input').focus();document.getElementById('input').setSelectionRange(1,1);document.getElementById('input').dispatchEvent(new Event('input',{bubbles:true}))`);await shot('light-1440-inline-commands');await key('Escape');
 await click('btnCtx');await shot('light-1440-context');await key('Escape');
 await nativeCheck();
 for(const zoom of [1.25,1.5]){win.webContents.setZoomFactor(zoom);await shot('light-1440-zoom-'+zoom);await check('zoom '+zoom+' no page overflow',`document.documentElement.scrollWidth<=innerWidth`)}win.webContents.setZoomFactor(1);
 const typicalText="已检查会话切换和右侧面板的状态边界。\n\n### 调整内容\n\n- 会话条目保持稳定顺序，选中和后台更新不会重新排序。\n- 每个会话保留自己的草稿与阅读位置。\n- 文件变更与浏览器共用右侧工作面板，关闭后焦点返回主入口。\n\n权限确认、模型回读和停止屏障继续沿用现有实现。";
 await read(`(()=>{VF.M.clearThread();VF.ST.el.title.textContent='会话恢复与面板稳定性 · 离线fixture';const text=${JSON.stringify(typicalText)};VF.M.onMessageStart({message:{role:'user',content:'检查一下会话切换和右侧面板的交互，保留现有业务能力。'}});VF.M.onMessageStart({message:{role:'assistant'}});VF.M.onMessageUpdate({assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:text}});VF.M.onMessageEnd({message:{role:'assistant',content:[{type:'text',text}]}});document.getElementById('input').value='';document.getElementById('input').dispatchEvent(new Event('input',{bubbles:true}));})()`);
 for(const theme of ['dark','light']){await read(`(async()=>{await (await import('/theme.js')).setThemePreference(${JSON.stringify(theme)})})()`);await shot(theme+'-1440-typical-chat');}
 await read(`(()=>{for(let i=0;i<3;i++){VF.T.onToolStart({toolCallId:'qa-'+i,toolName:'read',args:{path:['public/app.js','public/right-pane.js','public/ui/workspace-surface.js'][i]}});VF.T.onToolEnd({toolCallId:'qa-'+i,result:{content:[{type:'text',text:'Offline fixture source excerpt'}]}});}document.querySelector('.ui2-tool-summary').id='qaToolSummary';})()`);
 await shot('light-1440-tool-summary');await check('tool activity starts collapsed',`document.querySelector('.tl-list').hidden`);await click('qaToolSummary');await check('tool activity expands on click',`!document.querySelector('.tl-list').hidden`);await shot('light-1440-tool-expanded');
 }

 const timer=setTimeout(()=>{console.error('capture timeout');app.exit(1)},process.env.DESIGN_NATIVE_INPUT_ONLY==='1'?900000:240000);
 app.on('browser-window-created',(_e,w)=>{if(win)return;win=w;w.webContents.on('console-message',(_e,level,message)=>{if(level>=3&&!/Electron Security Warning/.test(message))errors.push(String(message))});w.webContents.once('did-finish-load',()=>run().catch(e=>{errors.push(e.stack);console.error(e)}).finally(()=>{clearTimeout(timer);fs.writeFileSync(path.join(OUT,process.env.DESIGN_CAPTURE_SUPPLEMENT==='1'?'supplement-results.json':'capture-results.json'),JSON.stringify({entry:'production electron/main.cjs + public renderer',backend:'existing tests/visual-harness.cjs, offline TEMP fixtures',shots,observations,checks,nativeEvidence,errors},null,2));app.exit(errors.length||checks.some(c=>!c.ok)?1:0)}))});
 require(path.join(ROOT,'electron/main.cjs'));
}
