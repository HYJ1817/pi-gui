// Targeted real NSIS fault injection: timeout and uncertain rollback identity.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
if(process.platform!=='win32')throw Error('Windows only');
const ROOT=path.resolve(__dirname,'..'),world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-timeout-'));
execFileSync('icacls',[world,'/setintegritylevel','(OI)(CI)L'],{stdio:'ignore',windowsHide:true});
const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const nsis=process.env.NSIS_EXE||path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis/nsis-3.0.4.1-nsis-3.0.4.1/makensis.exe');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<150;i++){if(fn())return;await sleep(40);}throw Error('fixture timeout');}
(async()=>{
  const install=path.join(world,'installed'),updates=path.join(world,'updates'),run=path.join(updates,'install-fault'),data=path.join(world,'user-data');
  fs.mkdirSync(install);fs.mkdirSync(run,{recursive:true});fs.mkdirSync(data);
  fs.writeFileSync(path.join(install,'Pi GUI.exe'),'nonexecutable old-program identity fixture');
  fs.writeFileSync(path.join(install,'state.txt'),'original');fs.writeFileSync(path.join(data,'data.txt'),'preserve');
  const setup=path.join(updates,'Pi-GUI-Setup-0.27.0.exe'),source=path.join(world,'failure.nsi');
  fs.writeFileSync(source,`Unicode True\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "${setup}"\nSection\nFileOpen $0 "$INSTDIR\\state.txt" w\nFileWrite $0 "installer-writing"\nFileClose $0\nSleep 1800\nFileOpen $0 "$INSTDIR\\finished" w\nFileWrite $0 "finished"\nFileClose $0\nSetErrorLevel 9\nSectionEnd\n`);
  execFileSync(nsis,['/V2',source],{stdio:'pipe',windowsHide:true});
  const parent=spawn(process.execPath,['-e',"process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"],{stdio:['pipe','ignore','ignore'],windowsHide:true});
  const start=execFileSync(ps,['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${parent.pid}).StartTime.ToUniversalTime().Ticks.ToString()`],{encoding:'utf8',windowsHide:true}).trim();
  const request=path.join(run,'request.json');fs.writeFileSync(request,JSON.stringify({parentPid:parent.pid,parentStart:start,installer:setup,
    sha256:createHash('sha256').update(fs.readFileSync(setup)).digest('hex'),size:fs.statSync(setup).size,version:'0.27.0',previousVersion:'0.26.2',installDir:install,userData:data}));
  const helper=path.join(run,'helper.ps1');fs.writeFileSync(helper,fs.readFileSync(path.join(ROOT,'electron/update-helper.ps1'),'utf8').replace('WaitForExit(600000)','WaitForExit(500)'));
  // A directory at the result filename forces Set-Content to fail reliably.
  fs.mkdirSync(path.join(run,'result.json'));
  const p=spawn(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-Request',request],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let log='';p.stdout.on('data',b=>log+=b);p.stderr.on('data',b=>log+=b);const exited=new Promise(r=>p.once('exit',r));
  await until(()=>fs.existsSync(path.join(run,'ready')));fs.writeFileSync(path.join(run,'armed'),'armed');parent.stdin.end();
  await until(()=>fs.readFileSync(path.join(install,'state.txt'),'utf8')==='installer-writing');await sleep(800);
  const checks=[{name:'diagnostic path is unwritable',pass:fs.statSync(path.join(run,'result.json')).isDirectory()},
    {name:'helper still waits for live installer after timeout',pass:p.exitCode===null},
    {name:'no rollback while NSIS owns destination',pass:fs.readFileSync(path.join(install,'state.txt'),'utf8')==='installer-writing'}];
  const lock=execFileSync(ps,['-NoProfile','-NonInteractive','-Command',`try{$f=[IO.File]::Open('${path.join(updates,'install.lock')}',[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$f.Dispose();'unlocked'}catch{'locked'}`],{encoding:'utf8',windowsHide:true}).trim();
  checks.push({name:'install mutex remains held during timeout wait',pass:lock==='locked'});
  const code=await exited;checks.push({name:'timeout exits only after actual installer completion',pass:code===2&&fs.existsSync(path.join(install,'finished'))});
  checks.push({name:'user data unaffected',pass:fs.readFileSync(path.join(data,'data.txt'),'utf8')==='preserve'});
  const second=path.join(updates,'install-identity-fault'),secondInstall=path.join(world,'installed-identity'),secondData=path.join(world,'user-data-identity');
  fs.mkdirSync(second,{recursive:true});fs.mkdirSync(secondInstall);fs.mkdirSync(secondData);
  fs.writeFileSync(path.join(secondInstall,'Pi GUI.exe'),'second old-program identity fixture');
  fs.writeFileSync(path.join(secondInstall,'state.txt'),'original');fs.writeFileSync(path.join(secondData,'data.txt'),'preserve');
  const secondSetup=path.join(updates,'Pi-GUI-Setup-0.27.0.exe'),secondSource=path.join(world,'identity-failure.nsi');
  fs.writeFileSync(secondSource,`Unicode True\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "${secondSetup}"\nSection\nSetOutPath "$INSTDIR"\nFileOpen $0 "$OUTDIR\\state.txt" w\nFileWrite $0 "installer-changed"\nFileClose $0\nSystem::Call 'kernel32::CreateHardLinkW(w "$INSTDIR\\external-link.txt", w "${path.join(secondData,'data.txt')}", p 0) i .r1'\nSetErrorLevel 9\nSectionEnd\n`);
  execFileSync(nsis,['/V2',secondSource],{stdio:'pipe',windowsHide:true});
  const secondParent=spawn(process.execPath,['-e',"process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"],{stdio:['pipe','ignore','ignore'],windowsHide:true});
  const secondStart=execFileSync(ps,['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${secondParent.pid}).StartTime.ToUniversalTime().Ticks.ToString()`],{encoding:'utf8',windowsHide:true}).trim();
  const secondRequest=path.join(second,'request.json');fs.writeFileSync(secondRequest,JSON.stringify({parentPid:secondParent.pid,parentStart:secondStart,installer:secondSetup,
    sha256:createHash('sha256').update(fs.readFileSync(secondSetup)).digest('hex'),size:fs.statSync(secondSetup).size,version:'0.27.0',previousVersion:'0.26.2',installDir:secondInstall,userData:secondData}));
  const secondHelper=path.join(second,'helper.ps1');fs.copyFileSync(path.join(ROOT,'electron/update-helper.ps1'),secondHelper);
  const secondProcess=spawn(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',secondHelper,'-Request',secondRequest],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let secondLog='';secondProcess.stdout.on('data',b=>secondLog+=b);secondProcess.stderr.on('data',b=>secondLog+=b);
  const secondExited=new Promise(r=>secondProcess.once('exit',r));
  await until(()=>fs.existsSync(path.join(second,'ready')));fs.writeFileSync(path.join(second,'armed'),'armed');secondParent.stdin.end();
  const secondCode=await secondExited;
  const secondResult=fs.existsSync(path.join(second,'result.json'))?JSON.parse(fs.readFileSync(path.join(second,'result.json'),'utf8').replace(/^\uFEFF/,'')):null;
  checks.push({name:'real NSIS creates a hardlink to protected fixture data',pass:fs.existsSync(path.join(secondInstall,'external-link.txt'))&&fs.statSync(path.join(secondData,'data.txt')).nlink===2});
  checks.push({name:'uncertain rollback identity fails closed',pass:secondCode===3&&secondResult?.phase==='recovery_required'});
  checks.push({name:'uncertain rollback never claims rolled_back',pass:secondResult?.phase!=='rolled_back'});
  checks.push({name:'uncertain rollback leaves user data intact',pass:fs.readFileSync(path.join(secondData,'data.txt'),'utf8')==='preserve'});
  const out=process.env.APP_UPDATE_EVIDENCE||path.join(world,'evidence');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'timeout-fault-results.json'),JSON.stringify({checks,code,world,secondCode,secondResult},null,2));
  for(const c of checks)console.log((c.pass?'PASS ':'FAIL ')+c.name);console.log(`Windows timeout fault: ${checks.filter(c=>c.pass).length}/${checks.length}`);
  process.exitCode=checks.every(c=>c.pass)?0:1;
})().catch(e=>{console.error(e);process.exitCode=1;});
