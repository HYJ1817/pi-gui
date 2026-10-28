'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {createAppUpdate,detectMode}=require('./app-update.cjs');
const {readUpdateRecovery}=require('./app-update-recovery.cjs');

function startUpdateHelper(powershell,helper,request) {
  // DETACHED_PROCESS can make Windows PowerShell exit 0 without executing; an
  // attached host can die with the Electron console. Start-Process creates the
  // helper's own hidden host. The broker is NOT the install authority: after
  // readiness the helper's OS installation lock proves cancellation completed.
  const literal=value=>"'"+value.replaceAll("'","''")+"'";
  const args=`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${helper}" -Request "${request}"`;
  const command=`$ErrorActionPreference='Stop';$p=Start-Process -FilePath ${literal(powershell)} -ArgumentList ${literal(args)} -WindowStyle Hidden -PassThru;$p.WaitForExit();exit $p.ExitCode`;
  const child=spawn(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],
    {stdio:'ignore',windowsHide:true});
  child.unref();return child;
}

function installAppUpdate({app,ipcMain,origin,getWindow,getServer,readUpdate,quit,dialog,shell,
  inspectDesktop=()=>({ok:true,browsers:0}),prepareDesktop=async()=>{},resumeBackend=async()=>{}}) {
  const mode=process.platform==='win32'?detectMode({packaged:app.isPackaged,exe:process.execPath}):'development';
  const directory=path.join(app.getPath('temp'),'pi-gui-updates');
  let seq=0,runDir=null,completion=null,updater=null,confirming=false,helperDone=null,helperReady=false,recovering=false;
  async function waitForHelperRelease() {
    if(!helperReady){await helperDone;return;}
    for(;;){
      let handle;
      try{
        const lock=path.join(directory,'install.lock'),st=fs.lstatSync(lock);
        if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw Error('lock_identity');
        handle=fs.openSync(lock,'r+');return;
      }catch{await new Promise(resolve=>setTimeout(resolve,100));}
      finally{if(handle!==undefined)fs.closeSync(handle);}
    }
  }
  async function backend(action) {
    const child=getServer();if(!child?.connected)return {ok:false,code:'backend_unavailable'};
    const id=++seq;
    return new Promise(resolve=>{
      const finish=r=>{clearTimeout(timer);child.removeListener('message',message);child.removeListener('exit',exited);resolve(r);};
      const message=r=>{if(r?.type==='app-update'&&r.id===id)finish(r);};
      const exited=()=>finish({ok:false,code:'backend_exited'});
      const timer=setTimeout(()=>finish({ok:false,code:'backend_timeout'}),30000);
      child.on('message',message);child.once('exit',exited);
      child.send({type:'app-update',id,action},error=>{if(error)finish({ok:false,code:'backend_unavailable'});});
    });
  }
  const options={directory,version:app.getVersion(),mode,readUpdate,
    prepare:async()=>{
      const status=inspectDesktop();if(!status.ok)return status;
      const result=await backend('prepare');if(!result.ok)return result;
      // Browser draining can fail: do it while the backend can still resume.
      await prepareDesktop();return {ok:true};
    },release:async()=>{
      if(helperDone){
        // Even failed diagnostic writes cannot skip backend recovery or permit
        // a late installation. Keep this parent alive until the real helper
        // releases its OS lock, even if the bootstrap broker exited early.
        recovering=true;publish();
        try{fs.rmSync(path.join(runDir,'armed'),{force:true});}catch{}
        try{fs.writeFileSync(path.join(runDir,'cancelled'),'cancelled');}catch{}
      }
      try{await backend('release');}finally{
        if(helperDone)await waitForHelperRelease();
        recovering=false;publish();
      }
      if(!getServer()?.connected)await resumeBackend();
    },
    launch:async asset=>{
      helperReady=false;
      // Re-identify at the last boundary, never use a path supplied over IPC.
      if(detectMode({packaged:app.isPackaged,exe:process.execPath})!=='installed')throw Error('mode_changed');
      runDir=fs.mkdtempSync(path.join(directory,'install-'));
      const helper=path.join(runDir,'helper.ps1');fs.copyFileSync(path.join(__dirname,'update-helper.ps1'),helper);
      const powershell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
      const parentStart=execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks.ToString()`],{encoding:'utf8',windowsHide:true}).trim();
      const request=path.join(runDir,'request.json');
      fs.writeFileSync(request,JSON.stringify({parentPid:process.pid,parentStart,installer:asset.path,sha256:asset.sha256,size:asset.size,
        version:asset.version,previousVersion:app.getVersion(),installDir:path.dirname(process.execPath),userData:app.getPath('userData')}),{flag:'wx'});
      const child=startUpdateHelper(powershell,helper,request);
      helperDone=new Promise(resolve=>{child.once('error',resolve);child.once('exit',resolve);});
      let failed=false;child.once('error',()=>{failed=true;});child.once('exit',()=>{failed=true;});
      const deadline=Date.now()+15000;
      while(!fs.existsSync(path.join(runDir,'ready'))){if(failed||Date.now()>deadline)throw Error('helper_unavailable');await new Promise(r=>setTimeout(r,100));}
      helperReady=true;
      fs.writeFileSync(path.join(directory,'pending.json'),JSON.stringify({run:path.basename(runDir),expectedVersion:asset.version,previousVersion:app.getVersion()}));
    },
    quit:async()=>{
      const child=getServer();if(!child)throw Error('backend_unavailable');
      const exited=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{child.removeListener('exit',done);reject(Error('backend_exit_timeout'));},30000);
        function done(){clearTimeout(timer);resolve();}child.once('exit',done);
      });
      // Ensure a rejected exit waiter always has a handler even on IPC failure.
      exited.catch(()=>{});
      // The helper also requires this exact parent to exit and no cancellation.
      fs.writeFileSync(path.join(runDir,'armed'),'armed',{flag:'wx'});
      const r=await backend('shutdown');
      if(!r.ok)throw Error('shutdown_unconfirmed');await exited;
      await quit();
    },
  };
  const allowed=event=>event.sender===getWindow()?.webContents&&event.senderFrame===event.sender.mainFrame&&new URL(event.senderFrame.url).origin===origin;
  const guard=fn=>async(event,...args)=>{
    try {if(!allowed(event))return {ok:false,code:'forbidden'};return await fn(...args);}
    catch{return {ok:false,error:'更新操作失败，请重试或打开 Release 页面手动安装。'};}
  };
  const snapshot=()=>({...updater?.state()||{phase:'failed',mode,currentVersion:app.getVersion(),code:'cache',
    error:'更新缓存暂不可用。请检查临时目录的权限或空间，然后重试下载。'},...(completion?{completion}:{}),
    ...(recovering?{phase:'recovering',error:'正在撤销更新准备并恢复应用，请保持应用打开。完成后可以重试。'}:{})});
  const publish=()=>{const wc=getWindow()?.webContents;if(wc&&!wc.isDestroyed())wc.send('pi-gui:app-update-state',snapshot());};
  function initialize() {
    if(updater)return updater;
    try {
      updater=createAppUpdate(options);updater.onChange(publish);
      updater.restore().catch(()=>{});return updater;
    } catch {return null;}
  }
  ipcMain.handle('pi-gui:app-update-state',guard(()=>snapshot()));
  const pending=()=>completion?.phase==='waiting'?{ok:false,code:'update_pending',error:'更新助手仍在运行，请等待更新完成后再试。'}:null;
  ipcMain.handle('pi-gui:app-update-download',guard(request=>{
    if(pending())return pending();
    if(request?.confirm!==true||Object.keys(request).some(k=>k!=='confirm'))return {ok:false,code:'untrusted'};
    const current=initialize();return current?current.download(request):{ok:false,code:'cache',error:snapshot().error};
  }));
  ipcMain.handle('pi-gui:app-update-cancel',guard(()=>updater?.cancel()||{ok:true}));
  ipcMain.handle('pi-gui:app-update-folder',guard(async()=>{
    if(updater?.state().phase!=='ready'||mode!=='portable')return {ok:false};
    const error=await shell.openPath(directory);return {ok:!error};
  }));
  ipcMain.handle('pi-gui:app-update-install',guard(async request=>{
    if(pending())return pending();
    if(request?.confirm!==true||Object.keys(request).some(k=>k!=='confirm'))return {ok:false,error:'需要确认更新。'};
    if(confirming||updater?.state().phase!=='ready'||mode!=='installed')return {ok:false,code:'busy',error:'请先完成更新包下载和校验。'};
    confirming=true;
    try {
    const desktop=inspectDesktop(),status=desktop.ok?await backend('inspect'):desktop;
    if(!status.ok)return {ok:false,code:status.code||'busy',error:status.error||'暂时无法确认所有会话和后台操作已停止，请稍后重试。'};
    const choice=await dialog.showMessageBox(getWindow(),{type:'question',buttons:['稍后','重启以更新'],defaultId:0,cancelId:0,
      message:'重启以安装已验证的更新？',detail:`已检查所有会话、Agent、开发进程和待处理操作。${desktop.browsers?`将关闭 ${desktop.browsers} 个浏览器页面，页面中未提交的输入可能丢失。`:''}会话、项目与设置数据会保留。确认后会再次检查；仍有活动任务时拒绝更新，请先安全停止。`});
    if(choice.response!==1)return {ok:false,code:'cancelled'};
    return updater.install({confirm:true});
    } finally {confirming=false;}
  }));
  // Cache recognition is offline. Startup never downloads or launches an installer.
  initialize();
  completion=readUpdateRecovery(directory,app.getVersion(),mode);
  if(completion?.phase==='waiting') {
    const timer=setInterval(()=>{
      const next=readUpdateRecovery(directory,app.getVersion(),mode);
      if(next&&next.phase!=='waiting'){completion=next;clearInterval(timer);publish();}
    },500);
    timer.unref();app.once('before-quit',()=>clearInterval(timer));
  }
  return {canQuit:()=>!recovering};
}
module.exports={installAppUpdate,startUpdateHelper};
