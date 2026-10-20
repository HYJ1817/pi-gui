'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {createAppUpdate,detectMode}=require('./app-update.cjs');

function installAppUpdate({app,ipcMain,origin,getWindow,getServer,readUpdate,quit,dialog,shell}) {
  const mode=process.platform==='win32'?detectMode({packaged:app.isPackaged,exe:process.execPath}):'development';
  const directory=path.join(app.getPath('temp'),'pi-gui-updates');
  let seq=0,runDir=null,completion=null;
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
  const updater=createAppUpdate({directory,version:app.getVersion(),mode,readUpdate,
    prepare:()=>backend('prepare'),release:()=>backend('release'),
    launch:async asset=>{
      // Re-identify at the last boundary, never use a path supplied over IPC.
      if(detectMode({packaged:app.isPackaged,exe:process.execPath})!=='installed')throw Error('mode_changed');
      runDir=fs.mkdtempSync(path.join(directory,'install-'));
      const helper=path.join(runDir,'helper.ps1');fs.copyFileSync(path.join(__dirname,'update-helper.ps1'),helper);
      const powershell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
      const parentStart=execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks.ToString()`],{encoding:'utf8',windowsHide:true}).trim();
      const request=path.join(runDir,'request.json');
      fs.writeFileSync(request,JSON.stringify({parentPid:process.pid,parentStart,installer:asset.path,sha256:asset.sha256,size:asset.size,
        version:asset.version,previousVersion:app.getVersion(),installDir:path.dirname(process.execPath),userData:app.getPath('userData')}),{flag:'wx'});
      const child=spawn(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-Request',request],
        {detached:true,stdio:'ignore',windowsHide:true});
      let failed=false;child.once('error',()=>{failed=true;});child.once('exit',()=>{failed=true;});child.unref();
      const deadline=Date.now()+15000;
      while(!fs.existsSync(path.join(runDir,'ready'))){if(failed||Date.now()>deadline)throw Error('helper_unavailable');await new Promise(r=>setTimeout(r,100));}
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
      const r=await backend('shutdown');
      if(!r.ok)throw Error('shutdown_unconfirmed');await exited;
      fs.writeFileSync(path.join(runDir,'armed'),'armed',{flag:'wx'});
      await quit();
    },
  });
  const allowed=event=>event.sender===getWindow()?.webContents&&event.senderFrame===event.sender.mainFrame&&new URL(event.senderFrame.url).origin===origin;
  const guard=fn=>async(event,...args)=>{
    try {if(!allowed(event))return {ok:false,code:'forbidden'};return await fn(...args);}
    catch{return {ok:false,error:'更新操作失败，请重试或打开 Release 页面手动安装。'};}
  };
  ipcMain.handle('pi-gui:app-update-state',guard(()=>({...updater.state(),...(completion?{completion}:{})})));
  ipcMain.handle('pi-gui:app-update-download',guard(request=>updater.download(request)));
  ipcMain.handle('pi-gui:app-update-cancel',guard(()=>updater.cancel()));
  ipcMain.handle('pi-gui:app-update-folder',guard(async()=>{
    if(updater.state().phase!=='ready'||mode!=='portable')return {ok:false};
    const error=await shell.openPath(directory);return {ok:!error};
  }));
  ipcMain.handle('pi-gui:app-update-install',guard(async request=>{
    if(request?.confirm!==true||Object.keys(request).some(k=>k!=='confirm'))return {ok:false,error:'需要确认更新。'};
    const choice=await dialog.showMessageBox(getWindow(),{type:'question',buttons:['稍后','重启以更新'],defaultId:0,cancelId:0,
      message:'重启以安装已验证的更新？',detail:'应用会检查所有会话与后台操作。仍有活动任务时将拒绝更新，请先等待完成或在对应会话安全停止。'});
    if(choice.response!==1)return {ok:false,code:'cancelled'};
    return updater.install({confirm:true});
  }));
  updater.onChange(state=>{const wc=getWindow()?.webContents;if(wc&&!wc.isDestroyed())wc.send('pi-gui:app-update-state',{...state,...(completion?{completion}:{})});});
  // Cache recognition is offline. Startup never downloads or launches an installer.
  updater.restore().catch(()=>{});
  try {
    const pending=JSON.parse(fs.readFileSync(path.join(directory,'pending.json'),'utf8'));
    if(!/^install-[A-Za-z0-9]+$/.test(pending.run))throw Error('invalid');
    let result={phase:'unconfirmed'};
    try {result=JSON.parse(fs.readFileSync(path.join(directory,pending.run,'result.json'),'utf8').replace(/^\uFEFF/,''));}catch{}
    const completed=result.phase==='installed'&&pending.expectedVersion===app.getVersion();
    completion=completed?{phase:'completed',mode,version:app.getVersion()}
      :{phase:'failed',mode,error:'上次更新未完成。当前程序与用户数据已保留，可重试或打开 Release 页面手动安装。'};
    // Preserve the result in state, including offline or no-new-release startup.
  } catch { /* No pending update or helper still running. */ }
  return updater;
}
module.exports={installAppUpdate};
