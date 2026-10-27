// Explicit Windows Electron/PowerShell launch and parent-exit survival proof.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await sleep(50);}throw Error('helper startup/survival timeout');}
if(!process.versions.electron){
  if(process.platform!=='win32')throw Error('Windows Electron required');
  (async()=>{
    const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-helper-startup-'));
    const env={...process.env,APP_UPDATE_HELPER_WORLD:world};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_DISABLE_SANDBOX;delete env.NODE_OPTIONS;
    const child=spawn(require('electron'),[__filename],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    let log='';child.stdout.on('data',bytes=>log+=bytes);child.stderr.on('data',bytes=>log+=bytes);
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    const scripts=path.join(world,"脚本 '（测试）");
    assert.equal(code,0,log);assert.ok(fs.existsSync(path.join(scripts,'ready')));
    await until(()=>fs.existsSync(path.join(scripts,'after-parent-exit')));
    const checks=[{name:'production launcher executes PowerShell helper before exit',pass:true},{name:'helper survives exact Electron parent exit and finishes its work',pass:true}];
    const out=process.env.APP_UPDATE_EVIDENCE||path.join(world,'evidence');fs.mkdirSync(out,{recursive:true});
    fs.writeFileSync(path.join(out,'helper-startup.json'),JSON.stringify({world,checks,normalSandbox:true},null,2));
    console.log('Windows Electron helper startup/survival: 2/2');
  })().catch(error=>{console.error(error);process.exitCode=1;});
}else{
  const {app}=require('electron'),world=process.env.APP_UPDATE_HELPER_WORLD;
  app.setPath('userData',path.join(world,'profile'));
  app.whenReady().then(async()=>{
    assert.ok(!app.commandLine.hasSwitch('no-sandbox'));
    const scripts=path.join(world,"脚本 '（测试）");fs.mkdirSync(scripts);
    const script=path.join(scripts,'helper.ps1'),request=path.join(scripts,'request.json');
    fs.writeFileSync(request,JSON.stringify({pid:process.pid}));
    fs.writeFileSync(script,"param([string]$Request)\n$ErrorActionPreference='Stop'\n$config=Get-Content -LiteralPath $Request -Raw -Encoding UTF8 | ConvertFrom-Json\n$parent=[Diagnostics.Process]::GetProcessById($config.pid)\n$null=$parent.Handle\n[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'ready'),'ready')\nif(-not $parent.WaitForExit(10000)){exit 2}\n$parent.Dispose()\n[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'after-parent-exit'),'executed')\n");
    const child=require('../electron/app-update-desktop.cjs').startUpdateHelper(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),script,request);
    child.once('error',()=>app.exit(1));await until(()=>fs.existsSync(path.join(scripts,'ready')));app.exit(0);
  }).catch(error=>{console.error(error);app.exit(1);});
}
