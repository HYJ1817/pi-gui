// Real production settings, renderer modules and CSS; offline desktop capability fixture.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
if(!process.versions.electron){
  const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-ui-'));
  // Only this disposable fixture receives a low integrity label. The desktop
  // test runner has a restricted Windows token; user data ACLs stay untouched.
  if(process.platform==='win32')require('node:child_process').execFileSync('icacls',[world,'/setintegritylevel','(OI)(CI)L'],{stdio:'ignore',windowsHide:true});
  const env={...process.env,UPDATE_UI_WORLD:world};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
  const p=spawn(require('electron'),[__filename],{env,stdio:'inherit',windowsHide:true});p.on('exit',c=>{
    const evidence=path.join(world,'evidence');if(fs.existsSync(evidence)&&process.env.APP_UPDATE_EVIDENCE)fs.cpSync(evidence,path.resolve(process.env.APP_UPDATE_EVIDENCE),{recursive:true});
    console.log('Evidence: '+evidence+' ('+(process.env.ELECTRON_DISABLE_SANDBOX?'sandbox disabled':'normal sandbox')+')');
    process.exitCode=c||0;
  });
} else main().catch(e=>{console.error(e);require('electron').app.exit(1);});
async function main(){
  const {app,BrowserWindow,ipcMain}=require('electron');const world=process.env.UPDATE_UI_WORLD;
  const out=path.join(world,'evidence');fs.mkdirSync(out,{recursive:true});
  app.setPath('userData',path.join(world,'profile'));await app.whenReady();
  const preload=path.join(world,'preload.cjs');
  fs.writeFileSync(preload,`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('piGuiDesktop',{appUpdate:{state:()=>ipcRenderer.invoke('state'),onState:cb=>{ipcRenderer.on('state',(_e,s)=>cb(s));},setPreference:p=>ipcRenderer.invoke('preference',{preference:p}),ignore:()=>ipcRenderer.invoke('ignore'),unignore:()=>ipcRenderer.invoke('unignore'),download:()=>ipcRenderer.invoke('download'),cancel:()=>ipcRenderer.invoke('cancel'),install:()=>ipcRenderer.invoke('install'),openFolder:()=>Promise.resolve({ok:true})},openExternal:()=>Promise.resolve({ok:true})});`);
  let state={mode:'installed',phase:'idle',currentVersion:'0.30.0',preference:'manual',storedPreference:'manual',automaticSupported:true,automaticUnsupportedReason:null,discovery:{status:'available',latestVersion:'0.30.1',release:{tag:'v0.30.1',notes:Array.from({length:45},(_,i)=>'### 改进 '+(i+1)+'\n- Windows 应用内更新支持安全退出、多会话保护和 SHA256 校验。').join('\n'),url:'https://github.com/HYJ1817/pi-gui/releases/tag/v0.30.1',assets:[{kind:'installer',name:'Pi-GUI-Setup-0.30.1.exe',url:'https://github.com/HYJ1817/pi-gui/releases/download/v0.30.1/Pi-GUI-Setup-0.30.1.exe'}]},error:'',checkedAt:''},ignoredVersion:null,pausedVersion:null,ignored:false,paused:false,preferenceSaveFailed:false,installOnQuit:false},downloads=0,cancelled=0,installs=0,preferenceCalls=0,preferenceResult={ok:true,persisted:true};
  ipcMain.handle('state',()=>state);ipcMain.handle('preference',(_e,request)=>{preferenceCalls++;if(preferenceResult.ok){state={...state,preference:request.preference,storedPreference:request.preference};}return preferenceResult;});ipcMain.handle('ignore',()=>({ok:true}));ipcMain.handle('unignore',()=>({ok:true}));ipcMain.handle('download',()=>{downloads++;return {ok:true};});ipcMain.handle('cancel',()=>{cancelled++;return {ok:true};});ipcMain.handle('install',()=>{installs++;return {ok:true};});
  const harness=spawn(process.execPath,[path.join(ROOT,'tests/visual-harness.cjs')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',HARNESS_PORT:'0',VISUAL_UPLOAD_DIR:path.join(world,'uploads')},stdio:['ignore','pipe','pipe'],windowsHide:true});
  const origin=await new Promise((resolve,reject)=>{let s='';const timer=setTimeout(()=>reject(Error('harness timeout')),20000);harness.stdout.on('data',b=>{s+=b;const m=s.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});});
  const win=new BrowserWindow({width:1060,height:900,show:true,webPreferences:{preload,contextIsolation:true,nodeIntegration:false}});
  const checks=[];const read=js=>win.webContents.executeJavaScript(js,true);const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  function check(value,name){checks.push({name,pass:!!value});console.log(`${value?'PASS':'FAIL'} ${name}`);}
  const set=async next=>{state={...state,...next};win.webContents.send('state',state);await sleep(120);};
  const APP='[data-about-update="app"]';
  const click=label=>read(`[...document.querySelectorAll('${APP} .update-sec button')].find(b=>b.textContent===${JSON.stringify(label)})?.click()`);
  const appText=()=>read(`document.querySelector('${APP} .update-sec').textContent`);
  const openInfo=async()=>{await read(`document.querySelector('#navGlobalMore').click();document.querySelector('#navInfo').click()`);await sleep(250);};
  try {
    await win.loadURL(origin);await sleep(600);
    await read(`(async()=>{const original=window.fetch;window.fetch=(url,opts)=>String(url).includes('/api/update')?Promise.resolve(new Response(JSON.stringify({ok:true,currentVersion:'0.30.0',latestVersion:'0.30.1',updateAvailable:true,release:{tag:'v0.30.1',notes:${JSON.stringify(Array.from({length:45},(_,i)=>`### 改进 ${i+1}\n- Windows 应用内更新支持安全退出、多会话保护和 SHA256 校验。`).join('\n'))},url:'https://github.com/HYJ1817/pi-gui/releases/tag/v0.30.1',assets:[{kind:'installer',name:'Pi-GUI-Setup-0.30.1.exe',url:'https://github.com/HYJ1817/pi-gui/releases/download/v0.30.1/Pi-GUI-Setup-0.30.1.exe'},{kind:'portable',name:'Pi-GUI-0.30.1-portable.zip',url:'https://github.com/HYJ1817/pi-gui/releases/download/v0.30.1/Pi-GUI-0.30.1-portable.zip'},{kind:'checksums',name:'SHA256SUMS.txt',url:'https://github.com/HYJ1817/pi-gui/releases/download/v0.30.1/SHA256SUMS.txt'}]}}),{headers:{'content-type':'application/json'}})):original(url,opts);window.U=await import('/update.js');U.cancelUpdateAuto();await U.checkForUpdate();})()`);
    check(await read(`document.querySelector('#modal').hidden`),'new release does not automatically open modal');
    await openInfo();
    check(await read(`!!document.querySelector('${APP} .update-pref-row')&&[...document.querySelectorAll('${APP} .update-pref-row .ds-segment-item')].map(b=>b.textContent).join(',')==='自动,手动'`),'preference control renders inside the existing update card');
    await click('自动');await sleep(150);
    check(preferenceCalls===1&&state.preference==='automatic','automatic preference is saved through the trusted bridge');
    check(await read(`document.querySelector('${APP} .update-sec').textContent.includes('将在正常安全退出应用时自动安装')===false`),'automatic note is not shown before a package is ready');
    fs.writeFileSync(path.join(out,'update-preferences.png'),(await win.webContents.capturePage()).toPNG());
    preferenceResult={ok:false,error:'写入本地配置失败，请检查磁盘权限。'};
    await click('手动');await sleep(150);
    check(await read(`(()=>{const e=document.querySelector('${APP} .update-pref-error');return !!e&&!e.hidden&&e.textContent.includes('写入本地配置失败');})()`),'preference save failure is visible in the real renderer');
    check(await read(`[...document.querySelectorAll('${APP} .update-pref-row .ds-segment-item')].find(b=>b.textContent==='自动')?.getAttribute('aria-checked')==='true'`),'failed save does not fake a manual selection');
    fs.writeFileSync(path.join(out,'update-preference-error.png'),(await win.webContents.capturePage()).toPNG());
    preferenceResult={ok:true,persisted:true};
    await click('手动');await sleep(150);await click('自动');await sleep(150);
    check(preferenceCalls===4&&state.preference==='automatic','preference can be switched again after a visible failure');
    check(await read(`document.querySelector('${APP} .update-sec').textContent.includes('v0.30.1')&&document.querySelector('${APP} .update-sec').textContent.includes('下载更新')`),'version and initial download action');
    check(await read(`!!document.querySelector('#navInfo .settings-overview-item')||document.querySelector('#navInfo').getAttribute('aria-current')==='page'`),'info navigation owns the update page');
    await click('下载更新');check(downloads===1,'download is explicitly requested by click');
    await set({phase:'downloading',received:52428800,total:104857600,speed:2097152});
    check(await read(`!!document.querySelector('${APP} progress')&&document.querySelector('${APP} .update-sec').textContent.includes('50%')&&document.querySelector('${APP} .update-sec').textContent.includes('2.0 MB/s')`),'progress, percentage and speed');
    fs.writeFileSync(path.join(out,'downloading.png'),(await win.webContents.capturePage()).toPNG());
    await click('取消下载');check(cancelled===1,'cancel reaches desktop capability');
    await set({phase:'failed',error:'下载失败，请重试。'});check((await appText()).includes('重新下载'),'failure offers retry');
    fs.writeFileSync(path.join(out,'download-failed.png'),(await win.webContents.capturePage()).toPNG());
    await set({phase:'ready',version:'0.30.1',error:''});
    const bounds=await read(`(()=>{const n=document.querySelector('${APP} .update-notes'),b=document.querySelector('${APP} .update-fixed-actions'),s=document.querySelector('.settings-detail');const y=b.getBoundingClientRect().top;n.scrollTop=n.scrollHeight;return {scrollable:n.scrollHeight>n.clientHeight,stable:y===b.getBoundingClientRect().top,footer:!!b,pageScrolls:s.scrollHeight>s.clientHeight,contained:document.documentElement.scrollWidth<=innerWidth+1}})()`);
    check(bounds.scrollable&&bounds.stable&&bounds.footer&&bounds.contained,'release notes scroll independently and the settings page stays contained');
    await sleep(400);fs.writeFileSync(path.join(out,'restart-ready.png'),(await win.webContents.capturePage()).toPNG());
    win.setSize(760,650);await sleep(200);
    check(await read(`(()=>{const p=document.querySelector('${APP}'),s=document.querySelector('.settings-detail'),w=document.querySelector('.settings-detail-card');return !!p&&s.scrollHeight>=s.clientHeight&&w.getBoundingClientRect().right<=innerWidth+1&&document.documentElement.scrollWidth<=innerWidth+1;})()`),'small window scrolls the info page without horizontal overflow');
    fs.writeFileSync(path.join(out,'restart-ready-small.png'),(await win.webContents.capturePage()).toPNG());
    win.setSize(1060,900);await sleep(120);
    await click('重启以更新');check(installs===1,'restart requires explicit click');
    await click('稍后');check((await appText()).includes('查看更新'),'later postpones visible details');
    await read(`document.querySelector('#settingsReturn').click()`);await sleep(150);await openInfo();
    check((await appText()).includes('重启以更新'),'reopening settings recognizes ready package');
    await set({phase:'ready',mode:'portable'});check(await read(`!document.querySelector('${APP} .update-sec').textContent.includes('重启以更新')&&document.querySelector('${APP} .update-sec').textContent.includes('打开下载目录')`),'portable manual replacement only');
    await set({phase:'idle',mode:'development'});check((await appText()).includes('开发模式仅支持检查更新'),'development mode check only');
    await set({phase:'idle',mode:'installed',completion:{phase:'completed',version:'0.30.1'}});
    check((await appText()).includes('已更新至 v0.30.1'),'startup completion version displayed');
    await set({phase:'ready',completion:{phase:'waiting'}});
    check(await read(`document.querySelector('${APP} .update-sec').textContent.includes('等待更新完成')&&!document.querySelector('${APP} .update-fixed-actions')`),'active helper shows waiting without download or restart actions');
    fs.writeFileSync(path.join(out,'update-waiting.png'),(await win.webContents.capturePage()).toPNG());
    await set({phase:'idle',completion:{phase:'failed',error:'上次更新未完成，可重试或手动安装。'}});
    check(await read(`document.querySelector('.update-sec').textContent.includes('上次更新未完成')&&[...document.querySelectorAll('.update-sec button')].some(b=>b.textContent==='查看 Release')`),'terminal failure keeps understandable error and Release link');
    fs.writeFileSync(path.join(out,'ui-results.json'),JSON.stringify({checks,bounds},null,2));
  } finally {win.destroy();harness.kill();}
  console.log(`app-update Electron: ${checks.filter(c=>c.pass).length}/${checks.length}`);app.exit(checks.every(c=>c.pass)?0:1);
}
