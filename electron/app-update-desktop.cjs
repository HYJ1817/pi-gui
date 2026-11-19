'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {createAppUpdate,detectMode}=require('./app-update.cjs');
const {createPreferenceStore}=require('./app-update-policy.cjs');
const {createAppUpdateManager}=require('./app-update-manager.cjs');
const {createAutoQuitCoordinator}=require('./app-update-quit.cjs');
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
  const currentVersion=app.getVersion();
  let seq=0,runDir=null,completion=null,updater=null,confirming=false,helperDone=null,helperReady=false,recovering=false;
  let store=null,manager=null,coordinator=null,suppressAutoInstall=false,systemSessionEnding=false;
  async function waitForHelperRelease() {
    if(!helperReady){await helperDone;return;}
    for(;;) {
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
  const options={directory,version:currentVersion,mode,readUpdate,
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
      if(!getServer()?.connected){
        // The old backend was shut down. This is recovery, not a user-approved
        // update: relaunching must never re-enter the quit-install path.
        suppressAutoInstall=true;
        await resumeBackend();
      }
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
    quit:async(options={})=>{
      const child=getServer();if(!child)throw Error('backend_unavailable');
      // 自动安装的最后一道提交边界：授权检查与 armed 写入之间不允许有
      // 任何 await。IPC 事件、偏好切换、关机标记都跑在同一事件循环里，
      // 同步完成“复核 + 写入”才能消除这个竞态窗口。
      if(typeof options?.authorize==='function'){
        let allowed=false;try{allowed=options.authorize()===true;}catch{allowed=false;}
        if(!allowed)throw Object.assign(Error('revoked'),{code:'revoked'});
      }
      const exited=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{child.removeListener('exit',done);reject(Error('backend_exit_timeout'));},30000);
        function done(){clearTimeout(timer);resolve();}child.once('exit',done);
      });
      // Ensure a rejected exit waiter always has a handler even on IPC failure.
      exited.catch(()=>{});
      // The helper also requires this exact parent to exit and no cancellation.
      fs.writeFileSync(path.join(runDir,'armed'),'armed',{flag:'wx'});
      try {
        const r=await backend('shutdown');
        if(!r.ok)throw Error('shutdown_unconfirmed');await exited;
        coordinator?.markQuitIssued();
        await quit();
      } catch(error) {
        // armed 已落盘：后续失败也不能再走 cancelled/release 撤销路径。
        error.committed=true;
        throw error;
      }
    },
  };
  const allowed=event=>event.sender===getWindow()?.webContents&&event.senderFrame===event.sender.mainFrame&&new URL(event.senderFrame.url).origin===origin;
  const guard=fn=>async(event,...args)=>{
    try {if(!allowed(event))return {ok:false,code:'forbidden'};return await fn(...args);}
    catch{return {ok:false,error:'更新操作失败，请重试或打开 Release 页面手动安装。'};}
  };
  function fallbackSnapshot() {
    return {...updater?.state()||{phase:'failed',mode,currentVersion,code:'cache',
      error:'更新缓存暂不可用。请检查临时目录的权限或空间，然后重试下载。'},
      mode,currentVersion,preference:'manual',requestedPreference:'manual',storedPreference:'manual',
      persistedPreference:null,automaticSupported:false,automaticUnsupportedReason:'unavailable',
      automaticTrusted:false,overrideActive:false,overridePersisted:false,
      discovery:{status:'idle',latestVersion:'',release:null,error:'',checkedAt:''},
      ignoredVersion:null,pausedVersion:null,ignored:false,paused:false,
      installOnQuit:false,installOnQuitBlockedReason:'unavailable'};
  }
  const snapshot=()=>({...(manager?manager.snapshot():fallbackSnapshot()),
    ...(completion?{completion}:{}),
    ...(recovering?{phase:'recovering',error:'正在撤销更新准备并恢复应用，请保持应用打开。完成后可以重试。'}:{})});
  const publish=()=>{const wc=getWindow()?.webContents;if(wc&&!wc.isDestroyed())wc.send('pi-gui:app-update-state',snapshot());};
  const notify=notice=>{
    const wc=getWindow()?.webContents;
    if(wc&&!wc.isDestroyed())wc.send('pi-gui:app-update-notice',{
      kind:notice.kind==='ready'?'ready':'available',
      version:typeof notice.version==='string'?notice.version:'',
    });
  };
  async function autoPreflight() {
    // No user confirmation exists on this path, so an open browser is treated
    // as potential unsaved input and blocks auto-install. Explicit install
    // keeps its native confirmation and existing browser warning.
    if(!getWindow())return {ok:false,code:'no-window',error:'主窗口已关闭，跳过自动安装。'};
    const desktop=inspectDesktop();
    if(!desktop.ok)return desktop;
    if(desktop.browsers>0)return {ok:false,code:'busy-browser',error:'仍有打开的浏览器页面，请先关闭后退出。'};
    return backend('inspect');
  }
  function initialize() {
    if(updater)return updater;
    try {
      updater=createAppUpdate(options);
      updater.onChange(()=>{if(!manager)publish();});
      try {
        store=createPreferenceStore({file:path.join(app.getPath('userData'),'app-update-preferences.json')});
        manager=createAppUpdateManager({updater,store,mode,currentVersion,platform:process.platform,packaged:app.isPackaged,
          readUpdate, publish, notify, isBlocked:()=>completion?.phase==='waiting'});
      } catch {
        store=null;manager=null;
      }
      coordinator=createAutoQuitCoordinator({manager,
        install:options=>updater.install({confirm:true},
          options&&typeof options.authorize==='function'?{authorize:options.authorize}:undefined),
        preflight:autoPreflight,
        quit:()=>quit(),
        authorize:()=>Boolean(manager&&manager.autoInstallStillAllowed()
          &&!systemSessionEnding&&!suppressAutoInstall),
        isRecovering:()=>recovering,
        isSuppressed:()=>suppressAutoInstall,
        isSystemShutdown:()=>systemSessionEnding,
      });
      // Startup never downloads or launches an installer. Restored packages are
      // only re-hashed; scheduling begins after that so an offline restore does
      // not delay the first check beyond its intended delay.
      Promise.resolve().then(()=>updater.restore()).catch(()=>{}).finally(()=>{
        if(manager)manager.start();
        publish();
      });
      return updater;
    } catch {
      updater=null;manager=null;coordinator=null;return null;
    }
  }
  ipcMain.handle('pi-gui:app-update-state',guard(()=>snapshot()));
  const pending=()=>completion?.phase==='waiting'?{ok:false,code:'update_pending',error:'更新助手仍在运行，请等待更新完成后再试。'}:null;
  ipcMain.handle('pi-gui:app-update-check',guard(()=>{
    if(!initialize()||!manager)return {ok:false,code:'unavailable',error:'应用内更新服务暂不可用。'};
    return manager.check({manual:true,force:true}).then(result=>({...result,snapshot:snapshot()}));
  }));
  ipcMain.handle('pi-gui:app-update-preference',guard(request=>{
    if(!request||typeof request!=='object'||Array.isArray(request)||
      Object.keys(request).length!==1||!Object.hasOwn(request,'preference'))return {ok:false,code:'untrusted'};
    if(!initialize()||!manager)return {ok:false,code:'unavailable',error:'更新偏好暂不可用。'};
    const result=manager.setPreference(request.preference);
    return {...result,snapshot:snapshot()};
  }));
  ipcMain.handle('pi-gui:app-update-ignore',guard(()=>{
    if(!initialize()||!manager)return {ok:false,code:'unavailable'};
    return {...manager.ignore(),snapshot:snapshot()};
  }));
  ipcMain.handle('pi-gui:app-update-unignore',guard(()=>{
    if(!initialize()||!manager)return {ok:false,code:'unavailable'};
    return {...manager.unignore(),snapshot:snapshot()};
  }));
  ipcMain.handle('pi-gui:app-update-download',guard(request=>{
    if(pending())return pending();
    if(request?.confirm!==true||Object.keys(request).some(k=>k!=='confirm'))return {ok:false,code:'untrusted'};
    const current=initialize();if(!current)return {ok:false,code:'cache',error:snapshot().error};
    return manager?manager.download(request):current.download(request);
  }));
  ipcMain.handle('pi-gui:app-update-cancel',guard(()=>{
    if(!initialize())return {ok:false,code:'cache'};
    return manager?manager.cancel():updater?.cancel()||{ok:true};
  }));
  ipcMain.handle('pi-gui:app-update-folder',guard(async()=>{
    if(updater?.state().phase!=='ready'||mode!=='portable')return {ok:false};
    const error=await shell.openPath(directory);return {ok:!error};
  }));
  ipcMain.handle('pi-gui:app-update-install',guard(async request=>{
    if(pending())return pending();
    if(request?.confirm!==true||Object.keys(request).some(k=>k!=='confirm'))return {ok:false,error:'需要确认更新。'};
    if(confirming||updater?.state().phase!=='ready'||mode!=='installed')return {ok:false,code:'busy',error:'请先完成更新包下载和校验。'};
    const target=updater?.state().version;
    if(!/^\d+\.\d+\.\d+$/.test(target||''))return {ok:false,code:'busy',error:'更新目标版本无效，请重新下载。'};
    const live=manager?manager.snapshot():snapshot();
    if(live.ignored&&live.version===target)return {ok:false,code:'ignored',error:'此版本已被忽略，请先取消忽略再安装。'};
    confirming=true;
    try {
    const desktop=inspectDesktop(),status=desktop.ok?await backend('inspect'):desktop;
    if(!status.ok)return {ok:false,code:status.code||'busy',error:status.error||'暂时无法确认所有会话和后台操作已停止，请稍后重试。'};
    const choice=await dialog.showMessageBox(getWindow(),{type:'question',buttons:['稍后','重启以更新'],defaultId:0,cancelId:0,
      message:'重启以安装已验证的更新？',detail:`已检查所有会话、Agent、开发进程和待处理操作。${desktop.browsers?`将关闭 ${desktop.browsers} 个浏览器页面，页面中未提交的输入可能丢失。`:''}会话、项目与设置数据会保留。确认后会再次检查；仍有活动任务时拒绝更新，请先安全停止。`});
    if(choice.response!==1)return {ok:false,code:'cancelled'};
    if(!coordinator)return {ok:false,code:'unavailable',error:'更新安装服务暂不可用。'};
    // 原生对话框停留期间目标版本、忽略状态或运行阶段都可能变化。
    // armed 前还要再用这个同步回调复核一次。
    const stillAllowed=()=>{
      if(systemSessionEnding||suppressAutoInstall||recovering)return false;
      const state=updater?.state();
      if(!state||state.version!==target)return false;
      if(manager&&typeof manager.manualInstallStillAllowed==='function'){
        return manager.manualInstallStillAllowed(target)===true;
      }
      const current=manager?manager.snapshot():snapshot();
      return !(current.ignored&&current.version===target);
    };
    return coordinator.runExplicitInstall({authorize:stillAllowed});
    } finally {confirming=false;}
  }));
  // Cache recognition is offline. Startup never downloads or launches an installer.
  initialize();
  completion=readUpdateRecovery(directory,currentVersion,mode);
  if(completion?.phase==='waiting') {
    const timer=setInterval(()=>{
      const next=readUpdateRecovery(directory,currentVersion,mode);
      if(next&&next.phase!=='waiting'){completion=next;clearInterval(timer);publish();}
    },500);
    timer.unref();app.once('before-quit',()=>clearInterval(timer));
  }
  return {
    canQuit:()=>coordinator?coordinator.canQuit():!recovering,
    shouldDeferClose:()=>coordinator?coordinator.shouldDeferClose():false,
    beforeQuit:event=>coordinator?coordinator.beforeQuit(event):(()=>{if(!recovering)return false;event?.preventDefault?.();return true;})(),
    markSystemSessionEnding:()=>{systemSessionEnding=true;suppressAutoInstall=true;},
    snapshot,
    manager:()=>manager,
  };
}
module.exports={installAppUpdate,startUpdateHelper};
