# 审计证据与复现工具

基线为 `326cb3284c5bf67398290ca4cd6ea8bfd5ee8496`，参考 `92ae661f1e399e69d514086b46029b4c34ba1a92`。这些是只读审计附件，不属于生产代码或新的 canonical 测试入口。主报告给出每项证据的有效范围及失败。

- electron：本次正常沙箱97/97，73张图（66 renderer、7 native）；包含C/D/E/F各场景。
- browser：本次正常沙箱64/64，20个PNG文件，实际原生本地页面和窗口分别捕获。
- probes：25张独立探针截图；只读生产入口/事件，离线HTTP数据。存在图不代表通过。
- ui3-results.json：本次正常沙箱243/243；截图原件和全日志仍在本机TEMP根的ui3目录。
- ci：下载的五组schema v2结果与远端summary；ci-validated.json为准确身份下本地重新核对的结果。
- probe-results/probe2-results/probe6-results：各探针结构化事实；probe-results末尾search字段来自对隐藏footer的无效点击，不作搜索功能证据。有效键盘结果在probe6.searchDown。
- css-inventory：静态扫描候选，不把动态CSS变量或fallback候选自动当Bug；importantDeclarations为去注释计数。
- directed-tests：32个实际执行入口、退出码、日志摘要与SHA。session-concurrency alias包含4个叶命令。不把重叠断言加总。
- ui4.log：本次完整失败输出，没有修改原测试。
- source-manifest：被审计的生产/测试/package共692个文件摘要；文档不包含在内。
- image-manifest：118个本次PNG的原始摘要/尺寸；references为24张外部原图身份，没有修改或复制其像素。

原始日志保存在 `C:/Users/21022/AppData/Local/Temp/pi-gui-final-audit-b2626d3cd52a4ee8a4b92a96fd186ecb`。本地Git元数据 `FINAL_AUDIT_EVIDENCE_ROOT.txt` 保存该位置，不提交Git元数据。独立探针原文见下方，可复制到新的TEMP文件再运行；`ROOT`是本次实际仓库位置，换机器需显式替换。它们调用生产模块，不复制生产渲染/保存逻辑，不注册为持续测试，不写用户配置。

## 专项重跑

在仓库目录依次执行，避免并行可见窗口抢焦点。每次使用新的TEMP输出目录，不覆盖本次/历史图。

```powershell
$auditOut = Join-Path $env:TEMP ('pi-audit-rerun-' + [guid]::NewGuid().ToString('N'))
$env:SHELL_OUTPUT = Join-Path $auditOut 'electron'
node tests/theme-convergence-electron.cjs
$env:T2B_EVIDENCE_DIR = Join-Path $auditOut 'browser'
node tests/browser-workbench-electron.cjs
$env:UI3_EVIDENCE_ROOT = Join-Path $auditOut 'ui3'
node tests/ui3-integration-electron.cjs
$env:UI4_EVIDENCE_ROOT = Join-Path $auditOut 'ui4'
node tests/ui4-pane.cjs # 审计基线预期失败，不能改断言制造通过
```

## 独立探针执行说明

探针1检查设置7个详情页/新增供应商、主题与字号；探针2检查窄窗/其余既有设置页/空卡的modal入口；探针6检查真实Down、子tab投影及图表focus/hover。先读并核对fixture服务路径，再从仓库目录 `node <TEMP脚本路径>`；输出在脚本所在TEMP目录。生产preload/theme/CSS不改，正常沙箱，外联请求阻断，所有profile/上传/主题文件在TEMP。

更新页的两个缺失IPC报错来自此精简探针没有注册app-update-state handler，主报告未据此判生产更新损坏或通过。第一次probe3因探针字符串转义错误退出1；修复的只是TEMP脚本。probe5误用Electron键名ArrowDown没有触发导航；最终probe6改用工具支持的Down，才作为复现。初次CI重算因未传GITHUB身份失败，设置准确身份后退出0；都没有修改生产/测试或CI记录。

注意：综合专项会调用系统剪贴板，原测试未恢复旧内容（AUD-013）。复跑前应知晓此已确认副作用，不在日志存用户剪贴板。独立探针不执行消息复制。

## independent-probe.cjs

~~~javascript
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const ROOT='C:/pi-GUI',OUT=__dirname; const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-independent-audit-'));
if(!process.versions.electron){let env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const c=spawn(require(path.join(ROOT,'node_modules/electron')),[__filename],{env,stdio:'inherit',windowsHide:false});c.on('exit',c=>process.exit(c||0));}else main().catch(e=>{fs.writeFileSync(path.join(OUT,'probe-error.txt'),String(e.stack));require('electron').app.exit(1)});
async function main(){const{app,BrowserWindow,ipcMain,nativeTheme}=require('electron');app.setPath('userData',path.join(world,'profile'));app.commandLine.appendSwitch('force-device-scale-factor','1.5');await app.whenReady();let win;const h=spawn(process.execPath,[path.join(ROOT,'tests/visual-harness.cjs')],{cwd:world,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',HARNESS_PORT:'0',VISUAL_UPLOAD_DIR:path.join(world,'uploads')},stdio:['ignore','pipe','pipe'],windowsHide:true});
const origin=await new Promise((r,j)=>{let s='';h.stdout.on('data',d=>{s+=d;let m=s.match(/http:\/\/127\.0\.0\.1:\d+/);if(m)r(m[0]);});h.on('error',j);});
const theme=require(path.join(ROOT,'electron/theme.cjs')).createDesktopTheme({ipcMain,nativeTheme,getWindow:()=>win,origin,preferenceFile:path.join(world,'theme.json')});theme.register();ipcMain.handle('pi-gui:browser-agent-status',()=>({ok:false,error:'offline_fixture'}));
win=new BrowserWindow({width:1205,height:803,useContentSize:true,show:true,...theme.windowOptions(),titleBarStyle:'hidden',webPreferences:{preload:path.join(ROOT,'electron/preload.cjs'),additionalArguments:['--pi-gui-theme-bridge'],sandbox:true,contextIsolation:true,nodeIntegration:false}});
win.webContents.session.webRequest.onBeforeRequest((d,c)=>c({cancel:!d.url.startsWith(origin+'/')}));
const read=s=>win.webContents.executeJavaScript(s,true),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function click(s){await read(`document.querySelector(${JSON.stringify(s)}).scrollIntoView({block:'nearest'})`);await sleep(80);win.focus();win.webContents.focus();const p=await read(`(()=>{let r=document.querySelector(${JSON.stringify(s)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await sleep(300);}
async function shot(n){fs.writeFileSync(path.join(OUT,n+'.png'),(await win.webContents.capturePage()).toPNG());}
async function facts(){return read(`(()=>{const card=document.querySelector('.settings-detail-card');return{viewport:[innerWidth,innerHeight,devicePixelRatio],title:card?.getAttribute('aria-label'),cards:document.querySelectorAll('.settings-detail-card').length,overflow:document.documentElement.scrollWidth>innerWidth,actions:[...document.querySelectorAll('.settings-detail-card .modal-actions button')].map(b=>({text:b.textContent,display:getComputedStyle(b.parentElement).display,visible:b.checkVisibility(),rect:b.getBoundingClientRect().toJSON()})),headings:[...document.querySelectorAll('.settings-detail-card h3')].map(e=>({text:e.textContent,font:getComputedStyle(e).fontSize})),fields:[...document.querySelectorAll('.settings-detail-card input,.settings-detail-card textarea')].map(e=>({label:e.getAttribute('aria-label'),placeholder:e.placeholder,type:e.type}))}})()`);}
const results={sha:'326cb3284c5bf67398290ca4cd6ea8bfd5ee8496',sandbox:true,world,scenes:[]};try{await win.loadURL(origin);await sleep(2800);await click('#navGlobalMore');await shot('audit-settings-overview');
for(const id of ['navAppearance','navProviders','navProviderAuth','navDiagnostics','navLogs','navAppUpdates','navShortcutHelp']){await click('#'+id);await sleep(250);results.scenes.push({id,...await facts()});await shot('audit-'+id);if(id==='navProviders'){await click('.prov-btn-main');results.providerAdd=await facts();await shot('audit-provider-add-dark');await read(`(async()=>{const th=await import('/theme.js');await th.setThemePreference('light')})()`);await sleep(300);await shot('audit-provider-add-light');await read(`(async()=>{const th=await import('/theme.js');await th.setThemePreference('dark')})()`);}
}
await click('#navAppearance');results.scaleBefore=await facts();await read(`document.querySelector('input[type=range]').value='130';document.querySelector('input[type=range]').dispatchEvent(new Event('input',{bubbles:true}))`);results.scaleAfter=await facts();await shot('audit-appearance-130');
await click('#navGlobalMore');await read(`document.querySelector('#settingsSearchInput').value='NO_SUCH_SETTING';document.querySelector('#settingsSearchInput').dispatchEvent(new Event('input',{bubbles:true}))`);results.search=await read(`({nav:[...document.querySelectorAll('#globalMoreMenu section')].filter(e=>!e.hidden).length,overview:[...document.querySelectorAll('.settings-overview-item')].filter(e=>e.checkVisibility()).length})`);await shot('audit-settings-search');
fs.writeFileSync(path.join(OUT,'probe-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));}finally{theme.dispose();win.destroy();h.kill();app.exit();}}

~~~


## independent-probe2.cjs

~~~javascript
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const ROOT='C:/pi-GUI',OUT=__dirname; const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-independent-audit-'));
if(!process.versions.electron){let env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const c=spawn(require(path.join(ROOT,'node_modules/electron')),[__filename],{env,stdio:'inherit',windowsHide:false});c.on('exit',c=>process.exit(c||0));}else main().catch(e=>{fs.writeFileSync(path.join(OUT,'probe-error.txt'),String(e.stack));require('electron').app.exit(1)});
async function main(){const{app,BrowserWindow,ipcMain,nativeTheme}=require('electron');app.setPath('userData',path.join(world,'profile'));app.commandLine.appendSwitch('force-device-scale-factor','1.5');await app.whenReady();let win;const h=spawn(process.execPath,[path.join(ROOT,'tests/visual-harness.cjs')],{cwd:world,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',HARNESS_PORT:'0',VISUAL_UPLOAD_DIR:path.join(world,'uploads')},stdio:['ignore','pipe','pipe'],windowsHide:true});
const origin=await new Promise((r,j)=>{let s='';h.stdout.on('data',d=>{s+=d;let m=s.match(/http:\/\/127\.0\.0\.1:\d+/);if(m)r(m[0]);});h.on('error',j);});
const theme=require(path.join(ROOT,'electron/theme.cjs')).createDesktopTheme({ipcMain,nativeTheme,getWindow:()=>win,origin,preferenceFile:path.join(world,'theme.json')});theme.register();ipcMain.handle('pi-gui:browser-agent-status',()=>({ok:false,error:'offline_fixture'}));
win=new BrowserWindow({width:1205,height:803,useContentSize:true,show:true,...theme.windowOptions(),titleBarStyle:'hidden',webPreferences:{preload:path.join(ROOT,'electron/preload.cjs'),additionalArguments:['--pi-gui-theme-bridge'],sandbox:true,contextIsolation:true,nodeIntegration:false}});
win.webContents.session.webRequest.onBeforeRequest((d,c)=>c({cancel:!d.url.startsWith(origin+'/')}));
const read=s=>win.webContents.executeJavaScript(s,true),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function click(s){await read(`document.querySelector(${JSON.stringify(s)}).scrollIntoView({block:'nearest'})`);await sleep(80);win.focus();win.webContents.focus();const p=await read(`(()=>{let r=document.querySelector(${JSON.stringify(s)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await sleep(300);}
async function shot(n){fs.writeFileSync(path.join(OUT,n+'.png'),(await win.webContents.capturePage()).toPNG());}
async function facts(){return read(`(()=>{const card=document.querySelector('.settings-detail-card');return{viewport:[innerWidth,innerHeight,devicePixelRatio],title:card?.getAttribute('aria-label'),cards:document.querySelectorAll('.settings-detail-card').length,overflow:document.documentElement.scrollWidth>innerWidth,actions:[...document.querySelectorAll('.settings-detail-card .modal-actions button')].map(b=>({text:b.textContent,display:getComputedStyle(b.parentElement).display,visible:b.checkVisibility(),rect:b.getBoundingClientRect().toJSON()})),headings:[...document.querySelectorAll('.settings-detail-card h3')].map(e=>({text:e.textContent,font:getComputedStyle(e).fontSize})),fields:[...document.querySelectorAll('.settings-detail-card input,.settings-detail-card textarea')].map(e=>({label:e.getAttribute('aria-label'),placeholder:e.placeholder,type:e.type}))}})()`);}
const results={sha:'326cb3284c5bf67398290ca4cd6ea8bfd5ee8496',sandbox:true,world,scenes:[]};try{await win.loadURL(origin);await sleep(2800);await click('#navGlobalMore');await shot('audit-settings-overview');
async function layout(){return read(`(()=>{const sels=['#workSurface','.settings-grid','.settings-detail-card','.appearance-body','.ds-settings-row-multiline','.font-size-ctrls','.ds-segmented','.ds-slider-row'];return{viewport:[innerWidth,innerHeight,devicePixelRatio],rects:sels.map(s=>{let e=document.querySelector(s);if(!e)return{s};let r=e.getBoundingClientRect();let c=getComputedStyle(e);return{s,rect:r.toJSON(),scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,overflow:c.overflow,bg:c.backgroundColor,border:c.border,padding:c.padding,font:c.fontSize}})}})()`);}
await win.setContentSize(700,600);await sleep(220);results.overviewNarrow=await layout();await shot('audit-overview-narrow');
await click('#navAppearance');results.appearanceNarrow=await layout();await shot('audit-appearance-narrow');
await read(`document.querySelector('input[type=range]').value='130';document.querySelector('input[type=range]').dispatchEvent(new Event('input',{bubbles:true}))`);results.largeAppearanceNarrow=await layout();await shot('audit-appearance-narrow-130');
await win.setContentSize(1205,803);await sleep(220);await read(`document.querySelector('input[type=range]').value='100';document.querySelector('input[type=range]').dispatchEvent(new Event('input',{bubbles:true}))`);results.appearanceLayout=await layout();
for(const id of ['navExtensions','navMcp','navCapabilities','navPlanner']){await click('#'+id);await sleep(300);results.scenes.push({id,view:await read(`document.querySelector('#workspace').dataset.workspaceView`)});await shot('audit-'+id);}
await click('#navProviders');await read(`(async()=>{let p=await import('/providers.js');p.setProvidersData({providers:{},keyStates:{}})})()`);await shot('audit-provider-empty');await click('.prov-empty-btn');results.emptyProviderActions=await read(`({modalVisible:!document.querySelector('#modal').hidden,actions:[...document.querySelectorAll('#modal .modal-actions button')].map(e=>({text:e.textContent,visible:e.checkVisibility()}))})`);await shot('audit-provider-empty-add-modal');
await read(`document.querySelector('#modal .modal-actions button').click()`);fs.writeFileSync(path.join(OUT,'probe2-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));}finally{theme.dispose();win.destroy();h.kill();app.exit();}}


~~~


## independent-probe6.cjs

~~~javascript
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const ROOT='C:/pi-GUI',OUT=__dirname; const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-independent-audit-'));
if(!process.versions.electron){let env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const c=spawn(require(path.join(ROOT,'node_modules/electron')),[__filename],{env,stdio:'inherit',windowsHide:false});c.on('exit',c=>process.exit(c||0));}else main().catch(e=>{fs.writeFileSync(path.join(OUT,'probe-error.txt'),String(e.stack));require('electron').app.exit(1)});
async function main(){const{app,BrowserWindow,ipcMain,nativeTheme}=require('electron');app.setPath('userData',path.join(world,'profile'));app.commandLine.appendSwitch('force-device-scale-factor','1.5');await app.whenReady();let win;const h=spawn(process.execPath,[path.join(ROOT,'tests/visual-harness.cjs')],{cwd:world,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',HARNESS_PORT:'0',VISUAL_UPLOAD_DIR:path.join(world,'uploads')},stdio:['ignore','pipe','pipe'],windowsHide:true});
const origin=await new Promise((r,j)=>{let s='';h.stdout.on('data',d=>{s+=d;let m=s.match(/http:\/\/127\.0\.0\.1:\d+/);if(m)r(m[0]);});h.on('error',j);});
const theme=require(path.join(ROOT,'electron/theme.cjs')).createDesktopTheme({ipcMain,nativeTheme,getWindow:()=>win,origin,preferenceFile:path.join(world,'theme.json')});theme.register();ipcMain.handle('pi-gui:browser-agent-status',()=>({ok:false,error:'offline_fixture'}));
win=new BrowserWindow({width:1205,height:803,useContentSize:true,show:true,...theme.windowOptions(),titleBarStyle:'hidden',webPreferences:{preload:path.join(ROOT,'electron/preload.cjs'),additionalArguments:['--pi-gui-theme-bridge'],sandbox:true,contextIsolation:true,nodeIntegration:false}});
win.webContents.session.webRequest.onBeforeRequest((d,c)=>c({cancel:!d.url.startsWith(origin+'/')}));
const read=s=>win.webContents.executeJavaScript(s,true),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function click(s){await read(`document.querySelector(${JSON.stringify(s)}).scrollIntoView({block:'nearest'})`);await sleep(80);win.focus();win.webContents.focus();const p=await read(`(()=>{let r=document.querySelector(${JSON.stringify(s)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await sleep(300);}
async function shot(n){fs.writeFileSync(path.join(OUT,n+'.png'),(await win.webContents.capturePage()).toPNG());}
async function facts(){return read(`(()=>{const card=document.querySelector('.settings-detail-card');return{viewport:[innerWidth,innerHeight,devicePixelRatio],title:card?.getAttribute('aria-label'),cards:document.querySelectorAll('.settings-detail-card').length,overflow:document.documentElement.scrollWidth>innerWidth,actions:[...document.querySelectorAll('.settings-detail-card .modal-actions button')].map(b=>({text:b.textContent,display:getComputedStyle(b.parentElement).display,visible:b.checkVisibility(),rect:b.getBoundingClientRect().toJSON()})),headings:[...document.querySelectorAll('.settings-detail-card h3')].map(e=>({text:e.textContent,font:getComputedStyle(e).fontSize})),fields:[...document.querySelectorAll('.settings-detail-card input,.settings-detail-card textarea')].map(e=>({label:e.getAttribute('aria-label'),placeholder:e.placeholder,type:e.type}))}})()`);}
const results={sha:'326cb3284c5bf67398290ca4cd6ea8bfd5ee8496',sandbox:true,world,scenes:[]};try{await win.loadURL(origin);await sleep(2800);await click('#navGlobalMore');await shot('audit-settings-overview'); win.focus();win.webContents.focus();await read("document.querySelector('#settingsSearchInput').focus()");win.webContents.sendInputEvent({type:'keyDown',keyCode:'Down'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Down'});await sleep(150);results.searchDown=await read("({focused:document.activeElement.id,first:[...document.querySelectorAll('#globalMoreMenu section button')].find(e=>e.checkVisibility())?.id})");await shot('audit-search-arrow-down');
async function layout(){return read(`(()=>{const sels=['#workSurface','.settings-grid','.settings-detail-card','.appearance-body','.ds-settings-row-multiline','.font-size-ctrls','.ds-segmented','.ds-slider-row'];return{viewport:[innerWidth,innerHeight,devicePixelRatio],rects:sels.map(s=>{let e=document.querySelector(s);if(!e)return{s};let r=e.getBoundingClientRect();let c=getComputedStyle(e);return{s,rect:r.toJSON(),scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,overflow:c.overflow,bg:c.backgroundColor,border:c.border,padding:c.padding,font:c.fontSize}})}})()`);}
for(const id of ['navMcp','navCapabilities','navExtensions']){await click('#'+id);results.scenes.push({id,selection:await read(`({current:[...document.querySelectorAll('#globalMoreMenu [aria-current]')].map(e=>({id:e.id,current:e.getAttribute('aria-current')})),selected:document.querySelector('.ext-tab[aria-selected="true"]')?.dataset.tab,title:document.querySelector('#workViewTitle').textContent})`)});}
await click('#settingsReturn');
await read(`(async()=>{const th=await import('/theme.js'),m=await import('/messages.js');await th.setThemePreference('light');m.clearThread();m.setStreaming(false);const data={version:1,type:'line',title:'审计图表',labels:['A','B','C'],series:[{name:'数值',data:[1,2,3]}]};m.rebuildFromMessages([{role:'assistant',content:[{type:'text',text:String.fromCharCode(96).repeat(3)+'pi-gui-viz'+String.fromCharCode(10)+JSON.stringify(data)+String.fromCharCode(10)+String.fromCharCode(96).repeat(3)}]}])})()`);await sleep(300);await click('.viz-open-btn');await sleep(300);await read(`document.querySelector('.viz-point').focus()`);results.viz=await read(`(()=>{const tip=document.querySelector('.viz-tooltip'),body=document.querySelector('.viz-tip-body');return{visible:tip.checkVisibility(),background:getComputedStyle(tip).backgroundColor,color:getComputedStyle(body).color,text:body.textContent,theme:document.documentElement.dataset.theme,rect:tip.getBoundingClientRect().toJSON()}})()`);results.vizWrapper=await read(`document.querySelector('.viz-svg-wrapper').getBoundingClientRect().toJSON()`);await shot('audit-viz-keyboard-light');
const vp=await read(`(()=>{let r=document.querySelector('.viz-point').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);win.webContents.sendInputEvent({type:'mouseMove',...vp});await sleep(160);results.vizHover=await read(`(()=>{let t=document.querySelector('.viz-tooltip'),b=document.querySelector('.viz-tip-body'),button=document.querySelector('.viz-open-btn');return{rect:t.getBoundingClientRect().toJSON(),background:getComputedStyle(t).backgroundColor,color:getComputedStyle(b).color,buttonBackground:getComputedStyle(button).backgroundColor,buttonColor:getComputedStyle(button).color}})()`);await shot('audit-viz-hover-light');fs.writeFileSync(path.join(OUT,'probe6-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));}finally{theme.dispose();win.destroy();h.kill();app.exit();}}







~~~
