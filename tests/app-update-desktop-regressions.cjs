const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');

test('registry path is read through explicit UTF-8 output, including Chinese and spaces',t=>{
  if(process.platform!=='win32'){t.skip('Windows Registry reader');return;}
  const {readInstall}=require('../electron/app-update.cjs');
  let call;
  const value=readInstall({run:(exe,args,options)=>{call={exe,args,options};return 'C:\\安装版（测试）\\Pi GUI\r\n';}});
  assert.equal(value,'C:\\安装版（测试）\\Pi GUI');
  assert.match(call.exe,/powershell\.exe$/i);
  assert.match(call.args.at(-1),/OutputEncoding/);
  assert.match(call.args.at(-1),/UTF8Encoding/);
  assert.match(call.args.at(-1),/Registry.*CurrentUser/);
  assert.equal(call.options.windowsHide,true);
  assert.equal(readInstall({run:()=>{throw Error('registry unavailable');}}),null);
});

test('cache initialization failure keeps authenticated IPC available and can retry',async t=>{
  if(process.platform!=='win32'){t.skip('Windows packaged download mode');return;}
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-cache-fault-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const cache=path.join(dir,'pi-gui-updates');fs.writeFileSync(cache,'obstruction fixture');
  const handlers=new Map(),app=new EventEmitter(),frame={url:'http://127.0.0.1:7788/'};
  const wc={mainFrame:frame,isDestroyed:()=>false,send(){}};
  Object.assign(app,{isPackaged:true,getPath:()=>dir,getVersion:()=>'0.29.0'});
  let reads=0;
  require('../electron/app-update-desktop.cjs').installAppUpdate({app,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},
    origin:'http://127.0.0.1:7788',getWindow:()=>({webContents:wc}),getServer:()=>null,
    readUpdate:async()=>{reads++;return {ok:false};},quit(){},dialog:{},shell:{}});
  t.after(()=>app.emit('before-quit'));
  const call=(name,arg)=>handlers.get(`pi-gui:app-update-${name}`)({sender:wc,senderFrame:frame},arg);
  assert.equal((await call('state')).phase,'failed');
  assert.equal((await call('state')).code,'cache');
  assert.equal((await call('download',{confirm:true})).code,'cache');assert.equal(reads,0);
  assert.equal((await handlers.get('pi-gui:app-update-state')({sender:{},senderFrame:frame})).code,'forbidden');
  fs.unlinkSync(cache);
  await call('download',{confirm:true});assert.equal(reads,1,'a later request can initialize the cache again');
});

test('prepare timeout releases a late maintenance acquisition before allowing retry',async t=>{
  const {createAppUpdateMaintenance}=await import('../server/app-update-maintenance.js');
  const {createAppUpdate}=require('../electron/app-update.cjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-late-prepare-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let finishClose,paused=0,resumed=0;
  const gate=createAppUpdateMaintenance({busyReason:()=>null,otherBusy:()=>false,
    closeSessions:()=>new Promise(r=>finishClose=r),pause:async()=>{paused++;return {ok:true};},resume:async()=>resumed++});
  const bytes=Buffer.from('installer'),hash=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const name='Pi-GUI-Setup-0.30.0.exe';
  const u=createAppUpdate({directory:dir,version:'0.29.0',mode:'installed',
    readUpdate:async()=>({ok:true,currentVersion:'0.29.0',latestVersion:'0.30.0',updateAvailable:true,release:{tag:'v0.30.0',assets:[{name,size:bytes.length,digest:'sha256:'+hash,url:'https://github.com/HYJ1817/pi-gui/releases/download/v0.30.0/'+name}]}}),
    fetchImpl:async()=>new Response(bytes),prepare:async()=>{gate.prepare();return {ok:false,code:'backend_timeout'};},
    release:()=>gate.release(),launch:async()=>assert.fail('cannot install after timeout'),quit:async()=>assert.fail('cannot quit after timeout')});
  await u.download({confirm:true});const install=u.install({confirm:true});
  while(!finishClose)await new Promise(r=>setImmediate(r));
  finishClose();assert.equal((await install).ok,false);
  await new Promise(r=>setImmediate(r));
  assert.equal(gate.locked(),false,'late preparation must not strand the backend in maintenance');
  assert.equal(paused,0,'cancelled preparation never pauses Classic after cleanup finishes');
  assert.equal(resumed,1);
});

test('Windows helper reads BOM-less UTF-8 request paths losslessly',t=>{
  if(process.platform!=='win32'){t.skip('Windows PowerShell 5.1');return;}
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-unicode-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const request=path.join(root,'request.json'),reader=path.join(root,'reader.ps1');
  const expected={installDir:path.join(root,'安装版（测试）','Pi GUI'),userData:path.join(root,'用户 数据（测试）')};
  fs.writeFileSync(request,JSON.stringify(expected));
  const helper=fs.readFileSync(path.join(__dirname,'../electron/update-helper.ps1'),'utf8');
  const statement=helper.split(/\r?\n/).find(line=>line.includes('$config = Get-Content'));
  fs.writeFileSync(reader,'param([string]$Request)\n$ErrorActionPreference="Stop"\n[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)\n'+statement+'\n$config | ConvertTo-Json -Compress\n');
  const result=require('node:child_process').execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile','-NonInteractive','-File',reader,request],{encoding:'utf8',windowsHide:true});
  assert.deepEqual(JSON.parse(result),expected);
});

test('cancelled install preparation releases helper lock while parent stays usable',async t=>{
  if(process.platform!=='win32'){t.skip('Windows helper');return;}
  const {spawn,execFileSync}=require('node:child_process');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-helper-cancel-'));
  const install=path.join(root,'安装 目录'),updates=path.join(root,'updates'),run=path.join(updates,'install-fixture');
  fs.mkdirSync(install);fs.mkdirSync(run,{recursive:true});
  fs.writeFileSync(path.join(install,'Pi GUI.exe'),'old program fixture');
  const installer=path.join(updates,'Pi-GUI-Setup-0.30.0.exe');fs.writeFileSync(installer,'must never execute');
  const parent=spawn(process.execPath,['-e','process.stdin.resume()'],{stdio:['pipe','ignore','ignore'],windowsHide:true});
  const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const parentStart=execFileSync(ps,['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${parent.pid}).StartTime.ToUniversalTime().Ticks.ToString()`],{encoding:'utf8',windowsHide:true}).trim();
  const request=path.join(run,'request.json');fs.writeFileSync(request,JSON.stringify({parentPid:parent.pid,parentStart,installer,
    sha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(installer)).digest('hex'),size:fs.statSync(installer).size,
    version:'0.30.0',previousVersion:'0.29.0',installDir:install,userData:path.join(root,'用户 数据')}));
  const helper=spawn(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'../electron/update-helper.ps1'),'-Request',request],{stdio:'ignore',windowsHide:true});
  const exited=new Promise(r=>helper.once('exit',r));
  t.after(async()=>{if(helper.exitCode===null)helper.kill();parent.stdin.end();await exited;await new Promise(r=>parent.exitCode!==null?r():parent.once('exit',r));fs.rmSync(root,{recursive:true,force:true});});
  for(let i=0;i<100&&!fs.existsSync(path.join(run,'ready'));i++)await new Promise(r=>setTimeout(r,30));
  assert.ok(fs.existsSync(path.join(run,'ready')),'helper validates real UTF-8 request and becomes ready');
  fs.writeFileSync(path.join(run,'cancelled'),'cancelled');
  const stopped=await Promise.race([exited.then(()=>true),new Promise(r=>setTimeout(()=>r(false),2000))]);
  assert.equal(stopped,true,'helper must honor cancellation without waiting for application exit');
  assert.equal(parent.exitCode,null);assert.equal(fs.existsSync(path.join(run,'backup')),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(run,'result.json'),'utf8').replace(/^\uFEFF/,'')).phase,'cancelled');
});

test('cancel IO failure releases backend and waits for real helper lock even if broker exits early',async t=>{
  if(process.platform!=='win32'){t.skip('Windows desktop helper orchestration');return;}
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-handoff-io-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'pi-gui-updates'));
  const helper=new EventEmitter();helper.unref=()=>{};let lockHeld=true;
  const server=new EventEmitter();server.connected=true;let releases=0,resumed=0,options;
  server.send=(request,callback)=>{queueMicrotask(()=>{server.emit('message',{type:'app-update',id:request.id,ok:true});if(request.action==='release'){releases++;server.connected=false;}});callback?.();};
  const app=new EventEmitter();Object.assign(app,{isPackaged:true,getPath:()=>root,getVersion:()=>'0.29.0'});
  const frame={url:'http://127.0.0.1:7788/'},sent=[],wc={mainFrame:frame,isDestroyed:()=>false,send:(_channel,state)=>sent.push(state)};
  const desktopFile=path.join(__dirname,'../electron/app-update-desktop.cjs'),module={exports:{}};
  const req=name=>{
    if(name==='node:fs')return {...fs,openSync:(file,...args)=>{if(path.basename(file)==='install.lock'&&lockHeld)throw Object.assign(Error('locked'),{code:'EPERM'});return fs.openSync(file,...args);}};
    if(name==='./app-update.cjs')return {detectMode:()=>'installed',createAppUpdate:value=>{options=value;return {state:()=>({phase:'ready',mode:'installed'}),onChange(){},restore:async()=>{}};}};
    if(name==='node:child_process')return {execFileSync:()=> '1',spawn:(_file,args,settings)=>{
      assert.notEqual(settings.detached,true,'PowerShell must execute -File, not silently exit under DETACHED_PROCESS');
      const command=Buffer.from(args.at(-1),'base64').toString('utf16le');
      assert.match(command,/Start-Process/);assert.match(command,/-WindowStyle Hidden/);
      const request=/-Request "([^"]+)"/.exec(command)[1];
      fs.writeFileSync(path.join(path.dirname(request),'ready'),'ready');
      fs.writeFileSync(path.join(root,'pi-gui-updates/install.lock'),'lock');return helper;
    }};
    if(name.startsWith('./'))return require(path.resolve(path.dirname(desktopFile),name));return require(name);
  };
  require('node:vm').runInNewContext(fs.readFileSync(desktopFile,'utf8'),{require:req,module,exports:module.exports,__dirname:path.dirname(desktopFile),process,setTimeout,clearTimeout,setInterval,clearInterval,URL,Promise,Buffer});
  const controller=module.exports.installAppUpdate({app,ipcMain:{handle(){}},origin:'http://127.0.0.1:7788',getWindow:()=>({webContents:wc}),getServer:()=>server,
    readUpdate:async()=>({}),quit(){},dialog:{},shell:{},resumeBackend:async()=>{resumed++;}});
  await options.launch({version:'0.30.0',path:path.join(root,'installer.exe'),sha256:'0'.repeat(64),size:1});
  const run=path.join(root,'pi-gui-updates',fs.readdirSync(path.join(root,'pi-gui-updates')).find(n=>n.startsWith('install-')));
  fs.mkdirSync(path.join(run,'cancelled'));fs.mkdirSync(path.join(run,'armed'));
  const recovery=options.release();await new Promise(r=>setImmediate(r));
  assert.equal(releases,1,'marker write/remove faults cannot skip backend release');
  assert.equal(controller.canQuit(),false,'keep parent alive while helper outcome is not known');
  assert.equal(resumed,0,'do not relaunch while old helper could still install');
  assert.equal(sent.at(-1).phase,'recovering');
  helper.emit('exit',1);await new Promise(r=>setTimeout(r,120));
  assert.equal(controller.canQuit(),false,'broker exit is not evidence that the real helper stopped');
  lockHeld=false;await recovery;
  assert.equal(resumed,1);assert.equal(controller.canQuit(),true);
});
