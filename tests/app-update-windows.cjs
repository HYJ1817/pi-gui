// Explicit, offline Windows NSIS acceptance. Never install over the user's app.
// Input is a previously downloaded official portable archive, checked below.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn,execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),CURRENT=require('../package.json').version;
const FIXTURE_EXE='pi-update-fixture.exe';
const archive=process.argv.find(s=>s.startsWith('--previous-zip='))?.slice(15);
if(process.platform!=='win32'||!archive)throw Error('Windows only. Supply --previous-zip=<official v0.26.0 portable ZIP>. No downloads are performed.');
const digest=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
if(digest(archive)!=='c3f3bdaf0d58967954a515a2ddaef6badf8ae42c38bcf35dedf9771b731bc020')throw Error('previous official ZIP SHA256 mismatch');
const nsis=process.env.NSIS_EXE||path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis/nsis-3.0.4.1-nsis-3.0.4.1/makensis.exe');
const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-install-'));
execFileSync('icacls',[world,'/setintegritylevel','(OI)(CI)L'],{stdio:'ignore',windowsHide:true});
const out=path.join(ROOT,'docs/windows-update-evidence');fs.mkdirSync(out,{recursive:true});
const checks=[];const check=(value,name)=>{checks.push({name,pass:!!value});console.log((value?'PASS ':'FAIL ')+name);if(!value)throw Error(name);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function run(file,args,env=process.env){return new Promise((resolve,reject)=>{const p=spawn(file,args,{env,stdio:['ignore','pipe','pipe'],windowsHide:true});let log='';p.stdout.on('data',b=>log+=b);p.stderr.on('data',b=>log+=b);p.on('error',reject);p.on('exit',code=>code===0?resolve(log):reject(Error(`process exited ${code}: ${log.slice(-1800)}`)));});}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function until(fn,ms=45000){const end=Date.now()+ms;while(Date.now()<end){try{const r=await fn();if(r)return r;}catch{}await sleep(150);}throw Error('fixture timeout');}
function shell(code){return execFileSync(ps,['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true}).trim();}
let cdpPort;
async function closeOwned(pid){
  const info=await until(async()=>{const r=await fetch(`http://127.0.0.1:${cdpPort}/json/version`);return r.json();});
  const ws=new WebSocket(info.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  ws.send(JSON.stringify({id:1,method:'Browser.close'}));await new Promise(r=>ws.onclose=r);
  await run(ps,['-NoProfile','-NonInteractive','-Command',`$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p -and -not $p.WaitForExit(30000)){throw 'exit timeout'}; exit 0`]);
}
function silentNSIS(source){
  // Retain the real file extraction, close-running guard and error semantics.
  // Remove registration/shortcuts from this COPY only: all writes stay in TEMP.
  const lines=source.split(/\r?\n/),keep=[];
  for(let i=0;i<lines.length;i++){
    if(/^\s*(InstallDirRegKey|WriteRegStr|WriteRegDWORD|CreateShortCut|CreateDirectory.*\$SMPROGRAMS)/.test(lines[i])){
      while(/\\\s*$/.test(lines[i])&&i+1<lines.length)i++;continue;
    }keep.push(lines[i]);
  }return keep.join('\n').replace('SetCompressor /SOLID lzma','SetCompressor /FINAL zlib').replace('SetCompressorDictSize 64','');
}
async function compile(appDir,version,destination){
  const nsi=path.join(world,'fixture-installer.nsi');fs.writeFileSync(nsi,silentNSIS(fs.readFileSync(path.join(ROOT,'installer/pi-gui.nsi'),'utf8')));
  console.log(`Compiling isolated full NSIS ${version}…`);
  const log=await run(nsis,['/V2','/DAPP_NAME=Pi GUI Update Acceptance',`/DAPP_EXE=${FIXTURE_EXE}`,`/DVERSION=${version}`,`/DVI_VERSION=${version}.0`,
    '/DPUBLISHER=Pi GUI','/DCOPYRIGHT=Copyright (c) 2026 HYJ1817',`/DAPP_DIR=${appDir}`,`/DICON_FILE=${path.join(ROOT,'build/icon.ico')}`,'/DESTIMATED_KB=340000',`/DOUT_FILE=${destination}`,nsi]);
  fs.appendFileSync(path.join(out,'nsis-compile.log'),log);
}
(async()=>{
  let activePid=null;
  const install=path.join(world,'installed'),updates=path.join(world,'updates'),data=path.join(world,'user-data');
  fs.mkdirSync(updates);fs.mkdirSync(data);const unpack=path.join(world,'previous');fs.mkdirSync(unpack);
  const sentinels={};for(const n of ['projects','sessions','providers','oauth','settings','drafts','runtime']){
    const p=path.join(data,`fixture-${n}.txt`);fs.writeFileSync(p,`synthetic ${n} preservation fixture`);sentinels[p]=digest(p);
  }
  const port=await freePort();
  cdpPort=await freePort();
  const env={...process.env,PI_GUI_DATA:data,PI_GUI_LOG_DIR:path.join(world,'logs'),PORT:String(port),PI_GUI_OPEN:'0',PI_OFFLINE:'1',TEMP:world,TMP:world,ELECTRON_DISABLE_SANDBOX:'1'};
  delete env.NODE_OPTIONS;delete env.ELECTRON_RUN_AS_NODE;delete env.PI_CWD;
  async function health(version){return until(async()=>{const r=await fetch(`http://127.0.0.1:${port}/api/health`);const j=await r.json();return j.version===version;});}
  async function launchOld(){
    const p=spawn(path.join(install,FIXTURE_EXE),['--user-data-dir='+data,'--remote-debugging-port='+cdpPort],{env,stdio:'ignore',windowsHide:true});activePid=p.pid;p.on('error',()=>{});await health('0.26.0');return p;
  }
  async function helper(parent,installer,options={}){
    const dir=fs.mkdtempSync(path.join(updates,'install-'));const request=path.join(dir,'request.json');
    if(options.backupFailure)fs.writeFileSync(path.join(dir,'backup'),'fixture obstruction');
    fs.writeFileSync(request,JSON.stringify({parentPid:parent.pid,parentStart:shell(`(Get-Process -Id ${parent.pid}).StartTime.ToUniversalTime().Ticks.ToString()`),
      installer,sha256:digest(installer),size:fs.statSync(installer).size,version:CURRENT,previousVersion:'0.26.0',installDir:install,userData:data}));
    const helperFile=path.join(dir,'helper.ps1');fs.writeFileSync(helperFile,fs.readFileSync(path.join(ROOT,'electron/update-helper.ps1'),'utf8')
      .replace("'Pi GUI.exe'",`'${FIXTURE_EXE}'`)
      .replace("$start.Arguments = '--user-data-dir=",`$start.Arguments = '--remote-debugging-port=${cdpPort} --user-data-dir=`)
      .replaceAll('} catch {', '} catch { Write-Output $_.Exception.Message;'));
    const p=spawn(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helperFile,'-Request',request],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    let log='';p.stdout.on('data',b=>log+=b);p.stderr.on('data',b=>log+=b);
    const done=new Promise(resolve=>p.once('exit',code=>resolve({code,log})));
    await Promise.race([until(()=>fs.existsSync(path.join(dir,'ready'))),done.then(r=>{throw Error(`helper exited before ready ${r.code}: ${r.log}`);})]);
    check(!fs.existsSync(path.join(dir,'backup'))||options.backupFailure,'helper waits before changing installed files');
    fs.writeFileSync(path.join(dir,'armed'),'armed');await closeOwned(parent.pid);activePid=null;
    const result=await done;if(result.code!==0)throw Error(`helper ${result.code}: ${result.log}`);
    const record=JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8').replace(/^\uFEFF/,''));activePid=record.restartPid;
    return {record,dir};
  }
  try {
    await run(path.join(process.env.SystemRoot,'System32/tar.exe'),['-xf',archive.replace(/\\/g,'/'),'-C',unpack.replace(/\\/g,'/')]);
    const oldDir=fs.existsSync(path.join(unpack,'Pi GUI.exe'))?unpack:path.join(unpack,fs.readdirSync(unpack)[0]);
    check(require(path.join(oldDir,'resources/app/package.json')).version==='0.26.0','official previous program version verified');
    fs.renameSync(path.join(oldDir,'Pi GUI.exe'),path.join(oldDir,FIXTURE_EXE));
    const candidateDir=path.join(world,'candidate');fs.cpSync(path.join(ROOT,'dist-app/Pi GUI-win32-x64'),candidateDir,{recursive:true});
    fs.renameSync(path.join(candidateDir,'Pi GUI.exe'),path.join(candidateDir,FIXTURE_EXE));
    const oldSetup=path.join(world,'old-setup.exe'),newSetup=path.join(updates,`Pi-GUI-Setup-${CURRENT}.exe`);
    // Reuse only a fixture installer produced by a previous run, when explicitly
    // supplied for an iterative acceptance run. Default remains a clean build.
    if(process.env.PI_GUI_TEST_OLD_SETUP)fs.copyFileSync(process.env.PI_GUI_TEST_OLD_SETUP,oldSetup);
    else await compile(oldDir,'0.26.0',oldSetup);
    if(process.env.PI_GUI_TEST_NEW_SETUP)fs.copyFileSync(process.env.PI_GUI_TEST_NEW_SETUP,newSetup);
    else await compile(candidateDir,CURRENT,newSetup);
    await run(oldSetup,['/S','/D='+install],env);check(fs.existsSync(path.join(install,FIXTURE_EXE)),'old version installed into TEMP via real NSIS');
    const failedDir=path.join(world,'failed');fs.mkdirSync(failedDir);
    const failureInstaller=path.join(failedDir,`Pi-GUI-Setup-${CURRENT}.exe`);
    const failNSI=path.join(world,'failure.nsi');fs.writeFileSync(failNSI,`Unicode True\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "${failureInstaller}"\nSection\nSetOutPath "$INSTDIR\\resources\\app"\nFileOpen $0 "$OUTDIR\\package.json" w\nFileWrite $0 "partial write fixture"\nFileClose $0\nSetErrorLevel 9\nSectionEnd\n`);
    await run(nsis,['/V2',failNSI]);
    const packageFile=path.join(install,'resources/app/package.json'),originalPackage=digest(packageFile);
    let parent=await launchOld();check(true,'real previous Electron and backend start at v0.26.0');
    // Package path must stay under the owned update directory.
    const failCopy=path.join(updates,'failure');fs.mkdirSync(failCopy);const admittedFailure=path.join(failCopy,path.basename(failureInstaller));fs.copyFileSync(failureInstaller,admittedFailure);
    let result=await helper(parent,admittedFailure);check(result.record.phase==='rolled_back','nonzero installer with partial write restores old files');
    await health('0.26.0');check(digest(packageFile)===originalPackage,'old version is usable after rollback');await closeOwned(activePid);activePid=null;
    parent=await launchOld();result=await helper(parent,newSetup,{backupFailure:true});check(result.record.phase==='failed','backup failure is recorded');await health('0.26.0');check(true,'backup failure after exit restarts unchanged old application');await closeOwned(activePid);activePid=null;
    parent=await launchOld();result=await helper(parent,newSetup);check(result.record.phase==='installed','real NSIS upgrade returns success');
    await health(CURRENT);check(require(packageFile).version===CURRENT,'restarted real backend and installed package confirm new version');
    check(Object.entries(sentinels).every(([p,h])=>digest(p)===h),'all seven user data sentinel hashes preserved');
    await closeOwned(activePid);activePid=null;
    fs.writeFileSync(path.join(out,'windows-results.json'),JSON.stringify({world,currentVersion:CURRENT,previousVersion:'0.26.0',previousArchiveSha256:digest(archive),candidateInstallerSha256:digest(newSetup),checks,
      isolation:'Real NSIS source with registration and shortcuts removed from test copy only; unique executable filename and faster zlib compression; real full released old program and rebuilt candidate; restricted host test uses ELECTRON_DISABLE_SANDBOX=1.'},null,2));
    console.log(`Windows update acceptance: ${checks.filter(c=>c.pass).length}/${checks.length}`);
  } finally {
    if(activePid)try{await closeOwned(activePid);}catch{}
    fs.writeFileSync(path.join(out,'windows-checkpoint.json'),JSON.stringify({world,checks},null,2));
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
