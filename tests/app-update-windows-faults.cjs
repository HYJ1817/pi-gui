// Targeted real NSIS fault injection: failed diagnostic write during timeout.
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
  const out=path.join(ROOT,'docs/windows-update-evidence');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'timeout-fault-results.json'),JSON.stringify({checks,code,world},null,2));
  for(const c of checks)console.log((c.pass?'PASS ':'FAIL ')+c.name);console.log(`Windows timeout fault: ${checks.filter(c=>c.pass).length}/${checks.length}`);
  process.exitCode=checks.every(c=>c.pass)?0:1;
})().catch(e=>{console.error(e);process.exitCode=1;});
