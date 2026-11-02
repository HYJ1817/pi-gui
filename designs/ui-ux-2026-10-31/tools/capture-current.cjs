'use strict';
// Design evidence only. Production renderer/main, owned offline visual fixture.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../../..'),OUT=path.resolve(__dirname,'../evidence/current');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
if(!process.versions.electron) parent().catch(e=>{console.error(e);process.exitCode=1});else desktop();
async function parent(){
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-design-current-')); fs.mkdirSync(OUT,{recursive:true});let harness,proxy;
 try{
 harness=spawn(process.execPath,[path.join(ROOT,'tests/visual-harness.cjs')],{cwd:world,env:{...process.env,HARNESS_PORT:'0',VISUAL_PUBLIC_ROOT:path.join(ROOT,'public'),VISUAL_UPLOAD_DIR:path.join(world,'uploads')},stdio:['ignore','pipe','pipe'],windowsHide:true});
 harness.stderr.on('data',b=>process.stderr.write(b));
 const origin=await new Promise((resolve,reject)=>{let s='';const timer=setTimeout(()=>reject(Error('fixture timeout')),20000);harness.stdout.on('data',b=>{s+=b;const m=s.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}})});
 proxy=http.createServer((req,res)=>{
 if(req.url==='/api/health'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({app:'pi-gui',protocol:1,version:require(path.join(ROOT,'package.json')).version}));}
 if(req.url==='/api/processes'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true,generation:'design',enabled:false,available:true,cleanupPending:false,processes:[]}));}
 const up=http.request(origin+req.url,{method:req.method,headers:{...req.headers,host:new URL(origin).host}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});up.on('error',()=>{res.writeHead(502);res.end()});req.pipe(up);res.on('close',()=>up.destroy());
 });await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 const env={...process.env,DESIGN_CURRENT_WORLD:world,DESIGN_CAPTURE_SUPPLEMENT:process.argv.includes('--supplement')?'1':'0',PORT:String(proxy.address().port),PI_GUI_DATA:path.join(world,'data'),PI_GUI_LOG_DIR:path.join(world,'logs')};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(require('electron'),[__filename,'--user-data-dir='+path.join(world,'user-data')],{cwd:ROOT,env,stdio:'inherit',windowsHide:true});
 process.exitCode=await new Promise((r,j)=>{child.on('error',j);child.on('exit',c=>r(c??1))});
 }finally{harness?.kill();proxy?.closeAllConnections();proxy?.close();console.log('Fixture retained in TEMP: '+world);}
}
function desktop(){
 const {app}=require('electron');app.setPath('userData',path.join(process.env.DESIGN_CURRENT_WORLD,'user-data'));let win;const shots=[],observations=[],errors=[];
 const read=s=>win.webContents.executeJavaScript(s),click=id=>read(`document.getElementById(${JSON.stringify(id)})?.click()`);
 const key=async k=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:k});win.webContents.sendInputEvent({type:'keyUp',keyCode:k});await sleep(160)};
 const shot=async name=>{await sleep(350);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());shots.push(name+'.png');observations.push({name,...await read(`(()=>{const r=s=>{const e=document.querySelector(s);if(!e||e.hidden)return null;return e.getBoundingClientRect().toJSON()};return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,pageWidth:document.documentElement.scrollWidth,sidebar:r('#projectSidebar'),composer:r('#composerBox'),panel:r('#rightPane'),popover:r('#composerPopover'),active:document.activeElement?.id,text:document.body.innerText.slice(0,10000)}})()`)});console.log('Captured '+name)};
 async function run(){
 for(let i=0;i<100;i++){if(await read(`Boolean(document.getElementById('btnModel')&&document.querySelector('.pj-sess'))`))break;await sleep(120)}await sleep(1500);
 await read(`(async()=>{window.VF={M:await import('/messages.js'),T:await import('/tools.js'),ST:await import('/state.js')};await (await import('/theme.js')).setThemePreference('dark');VF.M.clearThread();VF.ST.S.switching=false})()`);
 win.setContentSize(1440,900);await shot('dark-1440-empty');
 if(process.env.DESIGN_CAPTURE_SUPPLEMENT==='1'){
  await read(`VF.M.clearThread();fetch('/api/__conversation?what=fixture')`);await sleep(800);await shot('dark-1440-full-fixture');
  await click('navChanges');await sleep(300);await read(`document.querySelector('.chg-main')?.click()`);await sleep(300);await shot('dark-1440-diff');await key('Escape');await read(`document.querySelector('#rightPaneClose,#browserClose')?.click()`);
  for(const id of ['navAppUpdates','navMcp','navProviderAuth','navCapabilities','navAppearance']){await click(id);await sleep(350);await shot('dark-1440-'+id);await key('Escape')}
  await click('navHome');await read(`document.querySelector('.pj-sess')?.click()`);await sleep(500);await shot('dark-1440-session-switch');return;
 }
 await read(`(()=>{const text='已核对现有的会话恢复路径。\\n\\n### 建议\\n\\n保持列表顺序稳定，按会话保存草稿与滚动位置。右侧面板只改变布局，不重建对话。\\n\\n| 场景 | 预期 |\\n|---|---|\\n| 切换会话 | 恢复草稿 |\\n| 展开面板 | 保留阅读位置 |\\n\\n~~~js\\nconst session = await restoreSession(id);\\nreturn session.draft;\\n~~~';VF.M.onMessageStart({message:{role:'user',content:'请核对会话恢复与右侧面板的交互。'}});VF.M.onMessageStart({message:{role:'assistant'}});VF.M.onMessageUpdate({assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:text}});VF.M.onMessageEnd({message:{role:'assistant',content:[{type:'text',text}]}});})()`);await shot('dark-1440-chat');
 await read(`(()=>{for(let i=0;i<5;i++){VF.T.onToolStart({toolCallId:'design-'+i,toolName:i===4?'bash':'read',args:i===4?{command:'node fixture-check.cjs'}:{path:'public/session-'+i+'.js'}});VF.T.onToolEnd({toolCallId:'design-'+i,result:{content:[{type:'text',text:i===4?'Fixture validation failed':'Fixture source text'}]},isError:i===4});}})()`);await shot('dark-1440-tools');
 for(const id of ['btnModel','btnThink']){await click(id);await shot('dark-1440-'+id);await key('Escape')}
 for(const id of ['navChanges','btnBrowser','btnSpecs','btnCollabDocs']){await click(id);await sleep(400);await shot('dark-1440-'+id);await read(`document.querySelector('#rightPaneClose,#browserClose')?.click()`)}
 for(const id of ['navPlanner','navExtensions']){await click(id);await sleep(550);await shot('dark-1440-'+id)}await click('navHome');
 await click('navGlobalMore');await shot('dark-1440-settings-menu');await key('Escape');
 for(const id of ['navProviders','navDiagnostics','navLogs','navAppUpdate','navPiUpdate']){const exists=await read(`Boolean(document.getElementById(${JSON.stringify(id)}))`);if(!exists){observations.push({unavailable:id});continue;}await click(id);await sleep(350);await shot('dark-1440-'+id);await key('Escape')}
 for(const theme of ['light','dark'])for(const [width,height] of [[1280,800],[1440,900],[1920,1080]]){win.setContentSize(width,height);await read(`(async()=>{await (await import('/theme.js')).setThemePreference(${JSON.stringify(theme)})})()`);await shot(theme+'-'+width+'-overview')}
 }
 const timer=setTimeout(()=>{console.error('capture timeout');app.exit(1)},120000);
 app.on('browser-window-created',(_e,w)=>{if(win)return;win=w;w.webContents.on('console-message',(_e,level,message)=>{if(level>=3&&!/Electron Security Warning/.test(message))errors.push(String(message))});w.webContents.once('did-finish-load',()=>run().catch(e=>{errors.push(e.stack);console.error(e)}).finally(()=>{clearTimeout(timer);fs.writeFileSync(path.join(OUT,process.env.DESIGN_CAPTURE_SUPPLEMENT==='1'?'supplement-results.json':'capture-results.json'),JSON.stringify({entry:'production electron/main.cjs + public renderer',backend:'existing tests/visual-harness.cjs, offline TEMP fixtures',shots,observations,errors},null,2));app.exit(errors.length?1:0)}))});
 require(path.join(ROOT,'electron/main.cjs'));
}
