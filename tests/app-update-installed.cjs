// Offline, real Windows Electron -> updater IPC -> helper -> NSIS -> relaunch.
// Only TEMP fixtures are written. Never overwrite an existing user installation.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{createHash}=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),CURRENT=require('../package.json').version;
if(process.platform!=='win32')throw Error('Windows desktop required');
const next=CURRENT.split('.').map(Number);next[2]++;const NEXT=next.join('.');
const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-installed-e2e-'));
const out=path.resolve(process.env.APP_UPDATE_EVIDENCE||path.join(world,'evidence'));fs.mkdirSync(out,{recursive:true});
const checks=[],sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exeName='pi-update-7573-fixture.exe',appName='Pi GUI Update Fixture';
function check(value,name){checks.push({name,pass:!!value});console.log((value?'PASS ':'FAIL ')+name);if(!value)throw Error(name);}
async function until(fn,name,timeout=60000){const deadline=Date.now()+timeout;while(Date.now()<deadline){try{const value=await fn();if(value)return value;}catch{}await sleep(100);}throw Error('timeout: '+name);}
function run(file,args,options={}){return new Promise((resolve,reject)=>{
  const child=spawn(file,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],...options});let log='';
  child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);child.once('error',reject);
  child.once('exit',code=>{if(options.log)fs.writeFileSync(options.log,log);code===0?resolve(log):reject(Error('process exit '+code+': '+log.slice(-2000)));});
});}
async function port(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const value=server.address().port;await new Promise(r=>server.close(r));return value;}
async function cdp(port){
  const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json(),tab=tabs.find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:'));
  if(!tab)return null;const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let id=0;const waiting=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&waiting.has(m.id)){waiting.get(m.id)(m);waiting.delete(m.id);}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{waiting.delete(n);reject(Error('CDP timeout '+method));},20000);
    waiting.set(n,result=>{clearTimeout(timer);result.error?reject(Error(result.error.message)):resolve(result.result);});ws.send(JSON.stringify({id:n,method,params}));});
  const read=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
  return {ws,send,read,async ensureInfo(){for(let i=0;i<75;i++){const status=await read(`(()=>{const later=[...document.querySelectorAll('button')].find(b=>b.textContent==='稍后设置'&&b.offsetParent!==null);if(later){later.click();return 'dismissed';}if(document.querySelector('[data-about-update="app"]'))return 'ready';document.querySelector('#navGlobalMore')?.click();document.querySelector('#navInfo')?.click();return 'opening';})()`);if(status==='ready')return;await sleep(200);}throw Error('info page unavailable');},
    async click(label){let rect=null;const deadline=Date.now()+8000;while(!rect&&Date.now()<deadline){rect=await read(`(()=>{const b=[...document.querySelectorAll('.update-sec button')].find(b=>b.textContent===${JSON.stringify(label)});if(!b||b.disabled)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);if(!rect){await this.ensureInfo();await sleep(100);}}
    if(!rect)throw Error('missing action '+label);await send('Input.dispatchMouseEvent',{type:'mousePressed',...rect,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',...rect,button:'left',clickCount:1});},
    async screenshot(name){const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name),Buffer.from(r.data,'base64'));}};
}
function instrument(appDir){
  fs.renameSync(path.join(appDir,'Pi GUI.exe'),path.join(appDir,exeName));
  const resources=path.join(appDir,'resources/app'),pkg=JSON.parse(fs.readFileSync(path.join(resources,'package.json'),'utf8'));
  pkg.main='fixture-entry.cjs';fs.writeFileSync(path.join(resources,'package.json'),JSON.stringify(pkg));
  fs.copyFileSync(path.join(ROOT,'tests/fixtures/app-update-installed-entry.cjs'),path.join(resources,'fixture-entry.cjs'));
  const core=path.join(resources,'app-update.cjs');fs.writeFileSync(core,fs.readFileSync(core,'utf8').replaceAll('Uninstall Pi GUI.exe',`Uninstall ${appName}.exe`).replaceAll("'Pi GUI.exe'",JSON.stringify(exeName)));
  const helper=path.join(resources,'update-helper.ps1');fs.writeFileSync(helper,fs.readFileSync(helper,'utf8').replaceAll("'Pi GUI.exe'",`'${exeName}'`));
}
async function compile(appDir,version,setup){
  const source=fs.readFileSync(path.join(ROOT,'installer/pi-gui.nsi'),'utf8'),lines=source.split(/\r?\n/),keep=[];
  for(let i=0;i<lines.length;i++){
    if(/^\s*(InstallDirRegKey|WriteRegStr|WriteRegDWORD|CreateShortCut|CreateDirectory.*\$SMPROGRAMS)/.test(lines[i])){while(/\\\s*$/.test(lines[i])&&i+1<lines.length)i++;continue;}keep.push(lines[i]);
  }
  const script=path.join(world,'installer-'+version+'.nsi');fs.writeFileSync(script,keep.join('\n').replace('SetCompressor /SOLID lzma','SetCompressor /FINAL zlib').replace('SetCompressorDictSize 64',''));
  const nsis=process.env.NSIS_EXE||path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis/nsis-3.0.4.1-nsis-3.0.4.1/makensis.exe');
  await run(nsis,['/V2',`/DAPP_NAME=${appName}`,`/DAPP_EXE=${exeName}`,`/DVERSION=${version}`,`/DVI_VERSION=${version}.0`,'/DPUBLISHER=Pi GUI','/DCOPYRIGHT=Copyright (c) 2026 HYJ1817',`/DAPP_DIR=${appDir}`,`/DICON_FILE=${path.join(ROOT,'build/icon.ico')}`,'/DESTIMATED_KB=340000',`/DOUT_FILE=${setup}`,script],{log:path.join(out,'nsis-'+version+'.log')});
}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
function timeout(promise,ms,name){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout: '+name)),ms);})]).finally(()=>clearTimeout(timer));}
async function closeMainWindow(pid){
  const ps=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  try{await run(ps,['-NoProfile','-NonInteractive','-Command',`$p=Get-Process -Id ${pid} -ErrorAction Stop; if(-not $p.MainWindowHandle){exit 2}; if(-not $p.CloseMainWindow()){exit 3}`]);return true;}catch{return false;}
}
function runDirs(root){
  const cache=path.join(root,'pi-gui-updates');
  return fs.existsSync(cache)?fs.readdirSync(cache,{withFileTypes:true}).filter(e=>e.isDirectory()&&e.name.startsWith('install-')).map(e=>path.join(cache,e.name)):[];
}
/* External observation for the commit order: helper run dir -> ready -> armed
 * -> backend shutdown -> main exit -> new version window. Only filesystem
 * markers and the public health endpoint are used; production code is not
 * instrumented for the test. */
function watchUpdateExit(root,pid,httpPort){
  const marks={startedAt:Date.now(),quitEvents:[],helperDir:null,ready:null,armed:null,pending:null,result:null,cancelled:null,runDirs:[],backendDown:null,oldExit:null,newWindow:null};
  const cache=path.join(root,'pi-gui-updates'),quitLog=path.join(root,'quit-events.jsonl'),newWindowFile=path.join(root,'window-'+NEXT+'.json');
  let stopped=false,timer=null,healthFailures=0;
  const observe=async()=>{
    if(stopped)return;
    try{
      if(fs.existsSync(cache)){
        for(const entry of fs.readdirSync(cache,{withFileTypes:true})){
          if(!entry.isDirectory()||!entry.name.startsWith('install-'))continue;
          const dir=path.join(cache,entry.name);
          if(!marks.runDirs.includes(dir))marks.runDirs.push(dir);
          if(marks.helperDir===null){const st=fs.statSync(dir);marks.helperDir=st.birthtimeMs||st.mtimeMs;}
          for(const [key,name] of [['ready','ready'],['armed','armed'],['pending','pending.json'],['result','result.json'],['cancelled','cancelled']]){
            const file=path.join(dir,name);
            if(marks[key]===null&&fs.existsSync(file))marks[key]=fs.statSync(file).mtimeMs;
          }
        }
      }
      if(fs.existsSync(quitLog)&&marks.quitEvents.length===0){
        marks.quitEvents=fs.readFileSync(quitLog,'utf8').trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
      }
      if(marks.newWindow===null&&fs.existsSync(newWindowFile))marks.newWindow=fs.statSync(newWindowFile).mtimeMs;
      // Observe backend shutdown before the main-process exit in the same tick.
      // The backend always exits first (quit waits for it), and recording the
      // timestamps in this order keeps that real ordering visible even when
      // both conditions first become true during the same 20 ms poll.
      if(marks.backendDown===null){
        try{
          const response=await fetch(`http://127.0.0.1:${httpPort}/api/health`,{signal:AbortSignal.timeout(400)});
          if(response.ok)healthFailures=0;else healthFailures+=1;
        }catch{healthFailures+=1;}
        if(healthFailures>=2)marks.backendDown=Date.now();
      }
      if(marks.oldExit===null&&!alive(pid))marks.oldExit=Date.now();
    }catch{/* observation must not fail the scenario */}
    if(!stopped)timer=setTimeout(observe,20);
  };
  void observe();
  return {marks,stop(){stopped=true;if(timer)clearTimeout(timer);}};
}
function syntheticData(dataDir){
  const hashes={};
  for(const name of ['projects','sessions','providers','oauth','settings','drafts','runtime']){
    const file=path.join(dataDir,'fixture-'+name+'.txt');
    fs.writeFileSync(file,'synthetic preservation fixture '+name);hashes[file]=hash(file);
  }
  return hashes;
}
async function autoScenario(name,{oldSetup,targetSetup,baseEnv,build=true},body){
  const root=path.join(world,'auto-'+name);fs.mkdirSync(root,{recursive:true});
  const installDir=path.join(root,'安装 程序'),profileDir=path.join(root,'profile'),dataDir=path.join(root,'data');
  fs.mkdirSync(profileDir,{recursive:true});fs.mkdirSync(dataDir,{recursive:true});
  const httpPort=await port(),cdpPort=await port();
  const env={...baseEnv,PORT:String(httpPort),PI_GUI_DATA:dataDir,PI_GUI_LOG_DIR:path.join(root,'logs'),TEMP:root,TMP:root,
    PI_UPDATE_E2E_RUN_DIR:root,PI_UPDATE_E2E_CDP:String(cdpPort)};
  await run(oldSetup,['/S','/D='+installDir],{env,windowsVerbatimArguments:true});
  check(fs.existsSync(path.join(installDir,`Uninstall ${appName}.exe`)),name+': real NSIS installed the fixture');
  const dataHashes=syntheticData(dataDir);
  const child=spawn(path.join(installDir,exeName),['--user-data-dir='+profileDir],{env,stdio:'ignore',windowsHide:true});
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  let client=null;
  try{
    await until(()=>fs.existsSync(path.join(root,'window-'+CURRENT+'.json')),name+' initial window');
    client=await until(()=>cdp(cdpPort),name+' initial CDP');
    await client.ensureInfo();
    return await body({root,installDir,profileDir,dataDir,env,httpPort,cdpPort,child,exited,client,dataHashes});
  }finally{
    try{client?.ws.close();}catch{}
    if(child.exitCode===null)child.kill();
  }
}
const readState=client=>client.read('window.piGuiDesktop.appUpdate.state()');
const waitReady=async(client,ms=180000)=>{
  let state;
  await until(async()=>{state=await readState(client);return state.phase==='ready';},'automatic download ready',ms);
  return state;
};
async function runAutoE2E({oldSetup,targetSetup,baseEnv}){
  // 1. Normal automatic path: UI preference -> background download -> real
  // WM_CLOSE -> helper -> NSIS -> new Electron -> persistence.
  await autoScenario('auto-success',{oldSetup,targetSetup,baseEnv},async s=>{
    const {root,installDir,profileDir,dataDir,httpPort,cdpPort,child,exited,client,dataHashes}=s;
    await client.read("localStorage.setItem('pi-gui.auto-update','preserve me')");
    let state=await readState(client);
    check(state.mode==='installed'&&state.currentVersion===CURRENT,'auto: real installed shape and version');
    check(state.discovery.status==='available'&&state.discovery.latestVersion===NEXT,'auto: offline official release discovered');
    // The background discovery bookmark may already persist a manual default;
    // what matters is that automatic permission requires the user's explicit
    // opt-in. Reading state must never itself grant automatic.
    const preferenceFile=path.join(profileDir,'app-update-preferences.json');
    const initialPreference=fs.existsSync(preferenceFile)?JSON.parse(fs.readFileSync(preferenceFile,'utf8')).preference:null;
    check(initialPreference!=='automatic'&&state.preference==='manual'&&state.automaticTrusted===false,'auto: automatic permission starts absent until the user opts in');
    await client.click('自动');
    await until(async()=>{state=await readState(client);return state.preference==='automatic'&&state.automaticTrusted===true;},'automatic preference saved');
    check(JSON.parse(fs.readFileSync(path.join(profileDir,'app-update-preferences.json'),'utf8')).preference==='automatic','auto: automatic preference is really persisted');
    state=await waitReady(client);
    check(state.version===NEXT,'auto: the downloaded target is the official release');
    check(state.received===fs.statSync(targetSetup).size,'auto: full installer downloaded without a download click');
    check(state.installOnQuit===true&&state.automaticTrusted===true,'auto: ready package is eligible for installation on safe quit');
    check(!fs.existsSync(path.join(root,'native-confirm-ready')),'auto: no manual confirmation dialog was involved');
    // The first-run environment wizard can take the foreground on this packaged
    // fixture; the update card itself is what this assertion is about, so make
    // sure the information page is mounted before reading its live text.
    const ui=await until(async()=>{
      await client.ensureInfo();
      const text=await client.read(`document.querySelector('[data-about-update="app"] .update-sec')?.textContent||''`);
      return text.includes('正常安全退出应用时自动安装')?text:null;
    },'renderer safe-quit explanation',15000);
    check(ui.includes('正常安全退出应用时自动安装'),'auto: renderer explains installation on normal safe quit');
    await client.screenshot('installed-auto-ready.png');
    check(runDirs(root).length===0,'auto: no helper before the real window close');
    const watcher=watchUpdateExit(root,child.pid,httpPort);
    check(await closeMainWindow(child.pid),'auto: real WM_CLOSE sent to the application window');
    await timeout(exited,120000,'old application exit');
    await until(()=>fs.existsSync(path.join(root,'window-'+NEXT+'.json')),'new version startup',180000);
    watcher.stop();
    const m=watcher.marks;
    check(m.quitEvents.some(e=>e.event==='before-quit'),'auto: normal quit entered the coordinator');
    check(m.helperDir!==null&&m.ready!==null&&m.armed!==null,'auto: helper prepared and the armed marker was written');
    check(m.runDirs.length===1,'auto: exactly one install transaction');
    check(m.quitEvents[0].time<=m.helperDir,'auto: maintenance preflight started before helper preparation');
    check(m.helperDir<=m.ready&&m.ready<=m.armed,'auto: helper readiness precedes the armed commit');
    check(m.backendDown!==null&&m.armed<=m.backendDown,'auto: backend shutdown began only after the armed commit');
    check(m.oldExit!==null&&m.backendDown<=m.oldExit,'auto: backend exited before the main process');
    check(m.oldExit<=m.newWindow,'auto: the new version started only after the old process exited');
    // The PowerShell helper writes result.json with a UTF-8 BOM (Windows
    // PowerShell 5.1 `Out-File`); production strips it in app-update-recovery.
    const result=JSON.parse(fs.readFileSync(path.join(m.runDirs[0],'result.json'),'utf8').replace(/^﻿/,''));
    check(result.phase==='installed'&&result.expectedVersion===NEXT&&result.previousVersion===CURRENT,'auto: helper reports the real NSIS install result');
    const window=JSON.parse(fs.readFileSync(path.join(root,'window-'+NEXT+'.json'),'utf8'));
    check(window.pid!==child.pid,'auto: new version is a new process');
    check(window.sandbox,'auto: normal sandbox used for the restarted application');
    const restarted=await until(()=>cdp(cdpPort),'restarted CDP');
    try{
      await sleep(1000);await restarted.ensureInfo();await sleep(300);await restarted.ensureInfo();
      const nextState=await restarted.read('window.piGuiDesktop.appUpdate.state()');
      check(nextState.currentVersion===NEXT&&nextState.completion?.phase==='completed','auto: restarted app reports the installed version and completion');
      check(nextState.preference==='automatic'&&nextState.automaticTrusted===true,'auto: automatic preference survives the upgrade');
      const health=await(await fetch(`http://127.0.0.1:${httpPort}/api/health`)).json();
      check(health.version===NEXT,'auto: restarted backend independently confirms the target version');
      check(fs.readFileSync(path.join(installDir,'resources/app/installed-target.txt'),'utf8')==='actual NSIS payload '+NEXT,'auto: actual NSIS payload was replaced');
      check(await restarted.read("localStorage.getItem('pi-gui.auto-update')==='preserve me'"),'auto: Electron local settings survive the upgrade');
      check(Object.entries(dataHashes).every(([file,digest])=>hash(file)===digest),'auto: synthetic user data is unchanged');
      check(JSON.parse(fs.readFileSync(path.join(profileDir,'app-update-preferences.json'),'utf8')).preference==='automatic','auto: persisted preference file survives the upgrade');
      await restarted.screenshot('installed-auto-completed.png');
      await sleep(2500);
      check(runDirs(root).length===1,'auto: no second install transaction after the upgrade');
      check(!alive(child.pid),'auto: the old process never returns');
      await closeMainWindow(window.pid);
      await until(()=>!alive(window.pid),'restarted application exit',60000);
    }finally{restarted.ws.close();}
  });

  // 2. Manual + ready: closing the window must not install.
  await autoScenario('manual-ready',{oldSetup,targetSetup,baseEnv},async s=>{
    const {root,client,child,exited,installDir,httpPort}=s;
    await client.click('下载更新');
    const state=await waitReady(client);
    check(state.installOnQuit===false&&state.preference==='manual','manual: ready package is not eligible for quit installation');
    const watcher=watchUpdateExit(root,child.pid,httpPort);
    check(await closeMainWindow(child.pid),'manual: real WM_CLOSE sent');
    await timeout(exited,90000,'manual application exit');
    await sleep(1200);watcher.stop();
    check(runDirs(root).length===0,'manual: no helper or installation started');
    check(watcher.marks.armed===null,'manual: no armed marker');
    check(!fs.existsSync(path.join(root,'window-'+NEXT+'.json')),'manual: no new version started');
    check(JSON.parse(fs.readFileSync(path.join(installDir,'resources/app/package.json'),'utf8')).version===CURRENT,'manual: installed version unchanged');
  });

  // 3. Automatic but ignored: no installation on close.
  await autoScenario('ignored',{oldSetup,targetSetup,baseEnv},async s=>{
    const {root,client,child,exited,installDir,httpPort}=s;
    await client.click('自动');
    await waitReady(client);
    await client.click('忽略此版本');
    await until(async()=>{const state=await readState(client);return state.ignored===true&&state.installOnQuit===false;},'ignored state');
    const watcher=watchUpdateExit(root,child.pid,httpPort);
    check(await closeMainWindow(child.pid),'ignored: real WM_CLOSE sent');
    await timeout(exited,90000,'ignored application exit');
    await sleep(1200);watcher.stop();
    check(runDirs(root).length===0,'ignored: no helper or installation started');
    check(watcher.marks.armed===null,'ignored: no armed marker');
    check(!fs.existsSync(path.join(root,'window-'+NEXT+'.json')),'ignored: no new version started');
    check(JSON.parse(fs.readFileSync(path.join(installDir,'resources/app/package.json'),'utf8')).version===CURRENT,'ignored: installed version unchanged');
  });

  // 4. Automatic but an open browser holds potential unsaved input: the
  // maintenance preflight refuses installation and the app quits normally.
  await autoScenario('busy-browser',{oldSetup,targetSetup,baseEnv},async s=>{
    const {root,client,child,exited,installDir,httpPort}=s;
    await client.click('自动');
    await waitReady(client);
    const opened=await client.read('window.piGuiDesktop.browser.open()');
    check(opened?.ok===true,'busy-browser: browser view opened');
    const status=await client.read('window.piGuiDesktop.browser.agentStatus()');
    check(status?.open===true,'busy-browser: an open page is visible to the preflight');
    const watcher=watchUpdateExit(root,child.pid,httpPort);
    check(await closeMainWindow(child.pid),'busy-browser: real WM_CLOSE sent');
    await timeout(exited,90000,'busy-browser application exit');
    await sleep(1200);watcher.stop();
    check(runDirs(root).length===0,'busy-browser: preflight refused before helper preparation');
    check(watcher.marks.armed===null,'busy-browser: no armed marker');
    check(!fs.existsSync(path.join(root,'window-'+NEXT+'.json')),'busy-browser: no new version started');
    check(JSON.parse(fs.readFileSync(path.join(installDir,'resources/app/package.json'),'utf8')).version===CURRENT,'busy-browser: installed version unchanged');
  });

  // 5. Helper preparation fails (installation lock cannot be opened): the
  // unarmed helper is abandoned, no armed marker appears, and the old app
  // still exits normally without installing.
  await autoScenario('helper-failure',{oldSetup,targetSetup,baseEnv},async s=>{
    const {root,client,child,exited,installDir,httpPort}=s;
    await client.click('自动');
    await waitReady(client);
    const cache=path.join(root,'pi-gui-updates');fs.mkdirSync(cache,{recursive:true});
    fs.mkdirSync(path.join(cache,'install.lock'),{recursive:true});
    const watcher=watchUpdateExit(root,child.pid,httpPort);
    check(await closeMainWindow(child.pid),'helper-failure: real WM_CLOSE sent');
    await timeout(exited,120000,'helper-failure application exit');
    await sleep(800);watcher.stop();
    check(watcher.marks.runDirs.length===1,'helper-failure: preparation was attempted once');
    check(watcher.marks.ready===null,'helper-failure: helper never became ready');
    check(watcher.marks.armed===null,'helper-failure: armed marker was never written');
    check(!fs.existsSync(path.join(root,'window-'+NEXT+'.json')),'helper-failure: no new version started');
    check(JSON.parse(fs.readFileSync(path.join(installDir,'resources/app/package.json'),'utf8')).version===CURRENT,'helper-failure: old application remains installed and usable');
  });
}
(async()=>{
  let client,old,active;
  try{
    console.log('E2E fixture: '+world);
    const initial=path.join(world,'initial-app');fs.cpSync(path.join(ROOT,'dist-app/Pi GUI-win32-x64'),initial,{recursive:true});
    check(require(path.join(initial,'resources/app/package.json')).version===CURRENT,'rebuilt starting Electron version is '+CURRENT);
    const source=path.join(world,'next-source');fs.mkdirSync(source);
    for(const name of ['electron','extensions','lib','public','scripts','server','installer','vendor','assets','server.js','package.json','package-lock.json','LICENSE'])fs.cpSync(path.join(ROOT,name),path.join(source,name),{recursive:true});
    for(const name of ['package.json','package-lock.json']){const file=path.join(source,name),pkg=JSON.parse(fs.readFileSync(file,'utf8'));pkg.version=NEXT;if(pkg.packages?.[''])pkg.packages[''].version=NEXT;fs.writeFileSync(file,JSON.stringify(pkg));}
    fs.symlinkSync(path.join(ROOT,'node_modules'),path.join(source,'node_modules'),'junction');
    await run(process.execPath,[path.join(source,'scripts/build-app.mjs'),'--rebuild'],{cwd:source,env:process.env,log:path.join(out,'next-build.log')});
    const target=path.join(source,'dist-app/Pi GUI-win32-x64');
    instrument(initial);instrument(target);fs.writeFileSync(path.join(target,'resources/app/installed-target.txt'),'actual NSIS payload '+NEXT);
    const oldSetup=path.join(world,'initial-setup.exe'),targetSetup=path.join(world,'target-setup.exe');
    await compile(initial,CURRENT,oldSetup);await compile(target,NEXT,targetSetup);
    const install=path.join(world,'中文 安装（测试）','Pi GUI'),profile=path.join(world,'用户 数据（测试）'),data=path.join(world,'data');
    fs.mkdirSync(profile,{recursive:true});fs.mkdirSync(data);
    const dataHashes={};for(const name of ['projects','sessions','providers','oauth','settings','drafts','runtime']){const file=path.join(data,'fixture-'+name+'.txt');fs.writeFileSync(file,'synthetic preservation fixture '+name);dataHashes[file]=hash(file);}
    const httpPort=await port(),cdpPort=await port();
    const baseEnv={...process.env,PI_GUI_OPEN:'0',PI_OFFLINE:'1',PI_BIN:path.join(world,'missing-pi'),
      APPDATA:path.join(world,'home/AppData/Roaming'),LOCALAPPDATA:path.join(world,'home/AppData/Local'),HOME:path.join(world,'home'),USERPROFILE:path.join(world,'home'),
      PI_UPDATE_E2E_WORLD:world};
    for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_DISABLE_SANDBOX','NODE_OPTIONS','PI_CWD'])delete baseEnv[key];
    const env={...baseEnv,PORT:String(httpPort),PI_GUI_DATA:data,PI_GUI_LOG_DIR:path.join(world,'logs'),TEMP:world,TMP:world,
      PI_UPDATE_E2E_CDP:String(cdpPort)};
    fs.writeFileSync(path.join(world,'release.json'),JSON.stringify({ok:true,currentVersion:CURRENT,latestVersion:NEXT,updateAvailable:true,release:{tag:'v'+NEXT,notes:'Offline acceptance: real installer, safe exit, relaunch and running version.',url:'https://github.com/HYJ1817/pi-gui/releases/tag/v'+NEXT,
      assets:[{kind:'installer',name:`Pi-GUI-Setup-${NEXT}.exe`,url:`https://github.com/HYJ1817/pi-gui/releases/download/v${NEXT}/Pi-GUI-Setup-${NEXT}.exe`,size:fs.statSync(targetSetup).size,digest:'sha256:'+hash(targetSetup)}]}}));
    if(process.argv.includes('--auto')){
      await runAutoE2E({oldSetup,targetSetup,baseEnv});
      const evidence={world,scenario:'automatic safe-quit install plus layered refusal scenarios',previousVersion:CURRENT,targetVersion:NEXT,
        installerBytes:fs.statSync(targetSetup).size,installerSha256:hash(targetSetup),checks,
        isolation:'TEMP-only real NSIS and packaged Electron; test copies remove registry/shortcut writes, use a unique exe, zlib compression, a local official transport fixture and owned installation lookup. No production version change, no sandbox override, no manual install IPC and no native confirmation dialog on the automatic path.'};
      fs.writeFileSync(path.join(out,'installed-auto-e2e.json'),JSON.stringify(evidence,null,2));
      console.log(`Installed auto E2E: ${checks.filter(c=>c.pass).length}/${checks.length}`);
      return;
    }
    // NSIS /D must be the final, unquoted command-line tail. CreateProcess only;
    // no shell parses the directory. All fallback shell folders are TEMP too.
    await run(oldSetup,['/S','/D='+install],{env,windowsVerbatimArguments:true});check(fs.existsSync(path.join(install,`Uninstall ${appName}.exe`)),'real NSIS creates isolated installed program and uninstaller');
    fs.writeFileSync(path.join(world,'corrupt-download'),'fault');
    old=spawn(path.join(install,exeName),['--user-data-dir='+profile],{env,stdio:'ignore',windowsHide:true});active=old;
    const exited=new Promise(resolve=>old.once('exit',resolve));
    await until(()=>fs.existsSync(path.join(world,'window-'+CURRENT+'.json')),'initial packaged window');
    client=await until(()=>cdp(cdpPort),'initial CDP');
    await client.ensureInfo();
    let state=await client.read('window.piGuiDesktop.appUpdate.state()');check(state.mode==='installed'&&state.currentVersion===CURRENT,'real updater recognizes owned installed shape and running version');
    await client.read("localStorage.setItem('pi-gui.update-fixture','preserve local settings')");
    await client.click('下载更新');
    await until(async()=>{state=await client.read('window.piGuiDesktop.appUpdate.state()');return state.phase==='failed';},'checksum failure');
    check(/SHA256/.test(state.error),'corrupted real installer bytes rejected; old application remains usable');
    fs.unlinkSync(path.join(world,'corrupt-download'));await client.click('重新下载');
    await until(async()=>{state=await client.read('window.piGuiDesktop.appUpdate.state()');return state.phase==='downloading'&&state.received>0;},'progress');await client.screenshot('installed-downloading.png');
    await until(async()=>{state=await client.read('window.piGuiDesktop.appUpdate.state()');return state.phase==='ready';},'verified package');
    check(state.received===fs.statSync(targetSetup).size,'full installer downloaded and SHA256 verified');await client.screenshot('installed-ready.png');
    fs.writeFileSync(path.join(world,'fail-quit'),'fault');
    await client.click('重启以更新');await until(()=>fs.existsSync(path.join(world,'native-confirm-ready')),'native recovery confirmation');
    console.log((process.env.PI_UPDATE_E2E_AUTOMATED_CONFIRM==='1'?'CONFIRMATION_FIXTURE':'NATIVE_CONFIRM_REQUIRED')+' committed quit '+world);
    // The armed marker is the irreversible commit boundary. A one-shot app.quit
    // failure after it must not cancel the helper or roll back; the coordinator
    // requests one real quit and the armed helper completes the installation.
    await until(()=>fs.existsSync(path.join(world,'window-'+NEXT+'.json')),'installed newer Electron startup after committed quit fault',180000);
    await exited;client.ws.close();client=await until(()=>cdp(cdpPort),'committed-quit recovery CDP');await sleep(800);await client.ensureInfo();
    state=await client.read('window.piGuiDesktop.appUpdate.state()');
    check(state.currentVersion===NEXT&&state.completion?.phase==='completed','armed transaction still completes after a one-shot quit failure');
    check((await(await fetch(`http://127.0.0.1:${httpPort}/api/health`)).json()).version===NEXT,'restarted compiled backend independently confirms target version');
    check((await client.read('window.piGuiDesktop.browser.open()')).ok,'browser capability is usable after the committed transaction');
    await client.read('window.piGuiDesktop.browser.close()');
    await client.screenshot('installed-completed.png');
    // The failure suites below reuse this world and expect the accepted payload.
    await until(()=>fs.readFileSync(path.join(install,'resources/app/installed-target.txt'),'utf8')==='actual NSIS payload '+NEXT,'committed helper installed the accepted payload',180000);
    check(fs.readFileSync(path.join(install,'resources/app/installed-target.txt'),'utf8')==='actual NSIS payload '+NEXT,'committed helper installed the accepted payload');
    check(await client.read("localStorage.getItem('pi-gui.update-fixture')==='preserve local settings'"),'Electron local settings survive restart');
    check(Object.entries(dataHashes).every(([file,digest])=>hash(file)===digest),'all seven synthetic user data digests unchanged');
    check(JSON.parse(fs.readFileSync(path.join(world,'window-'+NEXT+'.json'))).sandbox,'normal sandbox used before and after restart');
    await client.read('window.close()');await until(async()=>{try{await fetch(`http://127.0.0.1:${cdpPort}/json/list`);return false;}catch{return true;}},'installed app exit');active=null;
    const evidence={world,previousVersion:CURRENT,targetVersion:NEXT,installerBytes:fs.statSync(targetSetup).size,installerSha256:hash(targetSetup),checks,
      confirmation:process.env.PI_UPDATE_E2E_AUTOMATED_CONFIRM==='1'?'explicit test-only dialog response fixture':'actual native dialog accepted by operator',
      isolation:'TEMP-only real NSIS and packaged Electron; test copy removes registry/shortcut writes, uses unique exe, zlib compression, local official transport fixture and owned installation lookup. Two separately built versions; no production version change. No sandbox override. Not official v0.29.0 to published v0.30.0 or user original-location qualification.'};
    fs.writeFileSync(path.join(out,'installed-e2e.json'),JSON.stringify(evidence,null,2));console.log(`Installed E2E: ${checks.filter(c=>c.pass).length}/${checks.length}`);
    if(process.env.PI_UPDATE_E2E_CONTINUE_FAILURE==='1'){
      for(const fault of ['exit','version']){
        await new Promise((resolve,reject)=>{
          const child=spawn(process.execPath,[path.join(__dirname,'app-update-installed-failure.cjs'),'--world='+world,'--failure='+fault],{env:{...process.env,APP_UPDATE_EVIDENCE:path.join(out,'failure-'+fault)},stdio:'inherit',windowsHide:true});
          child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('installed failure suite exited '+code)));
        });
      }
    }
  }finally{
    client?.ws.close();if(active&&active.exitCode===null)active.kill();
    fs.writeFileSync(path.join(out,'installed-e2e-checkpoint.json'),JSON.stringify({world,checks},null,2));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
