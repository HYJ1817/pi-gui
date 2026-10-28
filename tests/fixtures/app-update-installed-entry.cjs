// TEMP-only packaged acceptance entry. No production environment switch loads it.
// The real updater, preload, main, backend and renderer run unchanged except for
// the fixture executable/uninstaller identity applied to the copied package.
const fs=require('node:fs'),path=require('node:path');
const {app,BrowserWindow,dialog}=require('electron');
const world=process.env.PI_UPDATE_E2E_WORLD;
if(!world||!path.isAbsolute(world))throw Error('missing isolated acceptance directory');
app.commandLine.appendSwitch('remote-debugging-port',process.env.PI_UPDATE_E2E_CDP);
const release=JSON.parse(fs.readFileSync(path.join(world,'release.json'),'utf8'));
function info(){return {...release,currentVersion:app.getVersion(),updateAvailable:app.getVersion()!==release.latestVersion};}
const mode=require('./app-update.cjs'),detect=mode.detectMode;
// The installer copy omits global HKCU/shortcut writes. Reuse the exact realpath
// and uninstaller checks with this explicitly owned installation directory.
mode.detectMode=options=>detect({...options,readInstall:()=>path.dirname(process.execPath)});
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
  if(String(url).includes('/api/update'))return new Response(JSON.stringify(info()));
  if(String(url)!==release.release.assets[0].url)return originalFetch(url,options);
  const file=path.join(world,'target-setup.exe'),fd=fs.openSync(file,'r');let position=0;
  const corrupt=fs.existsSync(path.join(world,'corrupt-download'));
  return new Response(new ReadableStream({async pull(controller){
    if(options?.signal?.aborted){fs.closeSync(fd);controller.error(Error('cancelled'));return;}
    const bytes=Buffer.alloc(256*1024),n=fs.readSync(fd,bytes,0,bytes.length,position);
    if(!n){fs.closeSync(fd);controller.close();return;}
    if(corrupt&&position===0)bytes[0]^=1;position+=n;controller.enqueue(bytes.subarray(0,n));
    await new Promise(r=>setTimeout(r,4));
  },cancel(){fs.closeSync(fd);}}),{headers:{'content-length':String(fs.statSync(file).size)}});
};
const originalDialog=dialog.showMessageBox.bind(dialog);
const originalQuit=app.quit.bind(app);
app.quit=()=>{
  const failure=path.join(world,'fail-quit');
  if(fs.existsSync(failure)){fs.unlinkSync(failure);throw Error('injected post-shutdown quit failure');}
  return originalQuit();
};
dialog.showMessageBox=(...args)=>{
  if(args.at(-1)?.message==='重启以安装已验证的更新？'){
    fs.writeFileSync(path.join(world,'native-confirm-ready'),'ready');
    if(process.env.PI_UPDATE_E2E_AUTOMATED_CONFIRM==='1'){
      fs.appendFileSync(path.join(world,'confirmation-fixture.jsonl'),JSON.stringify({buttons:args.at(-1).buttons,response:1})+'\n');
      return Promise.resolve({response:1});
    }
  }
  return originalDialog(...args);
};
app.on('browser-window-created',(_event,win)=>{
  win.webContents.once('did-finish-load',async()=>{
    const value=info();
    await win.webContents.executeJavaScript(`(async()=>{
      const original=window.fetch;
      window.fetch=(url,options)=>String(url).includes('/api/update')?Promise.resolve(new Response(${JSON.stringify(JSON.stringify(value))},{headers:{'content-type':'application/json'}})):original(url,options);
      const update=await import('/update.js');update.cancelUpdateAuto();await update.checkForUpdate();
      const settings=await import('/settings.js');settings.openAppUpdates();
    })()`);
    win.show();win.focus();
    fs.writeFileSync(path.join(world,'window-'+app.getVersion()+'.json'),JSON.stringify({version:app.getVersion(),pid:process.pid,sandbox:!app.commandLine.hasSwitch('no-sandbox')}));
  });
});
require('./main.cjs');
