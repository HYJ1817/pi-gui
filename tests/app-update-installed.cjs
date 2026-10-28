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
  return {ws,send,read,async click(label){const rect=await read(`(()=>{const b=[...document.querySelectorAll('.update-sec button')].find(b=>b.textContent===${JSON.stringify(label)});if(!b||b.disabled)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
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
(async()=>{
  let client,old,active;
  try{
    console.log('E2E fixture: '+world);
    const initial=path.join(world,'initial-app');fs.cpSync(path.join(ROOT,'dist-app/Pi GUI-win32-x64'),initial,{recursive:true});
    check(require(path.join(initial,'resources/app/package.json')).version===CURRENT,'rebuilt starting Electron version is '+CURRENT);
    const source=path.join(world,'next-source');fs.mkdirSync(source);
    for(const name of ['electron','extensions','lib','public','scripts','server','installer','server.js','package.json','package-lock.json','LICENSE'])fs.cpSync(path.join(ROOT,name),path.join(source,name),{recursive:true});
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
    const env={...process.env,PORT:String(httpPort),PI_GUI_DATA:data,PI_GUI_LOG_DIR:path.join(world,'logs'),PI_GUI_OPEN:'0',PI_OFFLINE:'1',PI_BIN:path.join(world,'missing-pi'),TEMP:world,TMP:world,
      APPDATA:path.join(world,'home/AppData/Roaming'),LOCALAPPDATA:path.join(world,'home/AppData/Local'),HOME:path.join(world,'home'),USERPROFILE:path.join(world,'home'),
      PI_UPDATE_E2E_WORLD:world,PI_UPDATE_E2E_CDP:String(cdpPort)};
    for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_DISABLE_SANDBOX','NODE_OPTIONS','PI_CWD'])delete env[key];
    fs.writeFileSync(path.join(world,'release.json'),JSON.stringify({ok:true,currentVersion:CURRENT,latestVersion:NEXT,updateAvailable:true,release:{tag:'v'+NEXT,notes:'Offline acceptance: real installer, safe exit, relaunch and running version.',url:'https://github.com/HYJ1817/pi-gui/releases/tag/v'+NEXT,
      assets:[{kind:'installer',name:`Pi-GUI-Setup-${NEXT}.exe`,url:`https://github.com/HYJ1817/pi-gui/releases/download/v${NEXT}/Pi-GUI-Setup-${NEXT}.exe`,size:fs.statSync(targetSetup).size,digest:'sha256:'+hash(targetSetup)}]}}));
    // NSIS /D must be the final, unquoted command-line tail. CreateProcess only;
    // no shell parses the directory. All fallback shell folders are TEMP too.
    await run(oldSetup,['/S','/D='+install],{env,windowsVerbatimArguments:true});check(fs.existsSync(path.join(install,`Uninstall ${appName}.exe`)),'real NSIS creates isolated installed program and uninstaller');
    fs.writeFileSync(path.join(world,'corrupt-download'),'fault');
    old=spawn(path.join(install,exeName),['--user-data-dir='+profile],{env,stdio:'ignore',windowsHide:true});active=old;
    const exited=new Promise(resolve=>old.once('exit',resolve));
    await until(()=>fs.existsSync(path.join(world,'window-'+CURRENT+'.json')),'initial packaged window');
    client=await until(()=>cdp(cdpPort),'initial CDP');
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
    console.log((process.env.PI_UPDATE_E2E_AUTOMATED_CONFIRM==='1'?'CONFIRMATION_FIXTURE':'NATIVE_CONFIRM_REQUIRED')+' recovery '+world);
    await until(()=>JSON.parse(fs.readFileSync(path.join(world,'window-'+CURRENT+'.json'))).pid!==old.pid,'old application relaunched after failed handoff',180000);
    await exited;client.ws.close();client=await until(()=>cdp(cdpPort),'recovery CDP');
    state=await client.read('window.piGuiDesktop.appUpdate.state()');
    check(state.currentVersion===CURRENT&&state.completion?.phase==='failed','post-shutdown failure cancels helper and relaunches actual old version');
    check((await client.read('window.piGuiDesktop.browser.open()')).ok,'browser capability is usable after full old-app recovery');
    await client.read('window.piGuiDesktop.browser.close()');
    await client.screenshot('installed-recovered.png');
    fs.unlinkSync(path.join(world,'native-confirm-ready'));
    await client.click('重启以更新');await until(()=>fs.existsSync(path.join(world,'native-confirm-ready')),'native install confirmation');
    console.log((process.env.PI_UPDATE_E2E_AUTOMATED_CONFIRM==='1'?'CONFIRMATION_FIXTURE':'NATIVE_CONFIRM_REQUIRED')+' install '+world);
    // A real native dialog is accepted through the Windows UI by the operator.
    await until(()=>fs.existsSync(path.join(world,'window-'+NEXT+'.json')),'installed newer Electron startup',180000);
    client.ws.close();client=await until(()=>cdp(cdpPort),'restarted CDP');
    state=await client.read('window.piGuiDesktop.appUpdate.state()');
    check(state.currentVersion===NEXT&&state.completion?.phase==='completed','restarted app.getVersion and recovery confirm actual target version');
    check((await(await fetch(`http://127.0.0.1:${httpPort}/api/health`)).json()).version===NEXT,'restarted compiled backend independently confirms target version');
    check(fs.readFileSync(path.join(install,'resources/app/installed-target.txt'),'utf8')==='actual NSIS payload '+NEXT,'new program payload was actually installed');
    check(await client.read("localStorage.getItem('pi-gui.update-fixture')==='preserve local settings'"),'Electron local settings survive restart');
    check(Object.entries(dataHashes).every(([file,digest])=>hash(file)===digest),'all seven synthetic user data digests unchanged');
    check(JSON.parse(fs.readFileSync(path.join(world,'window-'+NEXT+'.json'))).sandbox,'normal sandbox used before and after restart');
    await client.screenshot('installed-completed.png');
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
