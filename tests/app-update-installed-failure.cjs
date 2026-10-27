// Real partial NSIS failure/rollback using the owned TEMP installed E2E result.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{createHash}=require('node:crypto'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),world=path.resolve(process.argv.find(a=>a.startsWith('--world='))?.slice(8)||'');
const temp=fs.realpathSync(os.tmpdir());
assert.ok(world.startsWith(temp+path.sep)&&/^pi-update-installed-e2e-[A-Za-z0-9]+$/.test(path.basename(world)),'owned TEMP E2E directory required');
const install=path.join(world,'中文 安装（测试）/Pi GUI'),resources=path.join(install,'resources/app');
const current=JSON.parse(fs.readFileSync(path.join(resources,'package.json'),'utf8')).version;
assert.equal(fs.readFileSync(path.join(resources,'installed-target.txt'),'utf8'),'actual NSIS payload '+current,'only prior owned acceptance payload may be used');
const target=current.split('.').map(Number);target[2]++;const version=target.join('.');
const out=path.resolve(process.env.APP_UPDATE_EVIDENCE||path.join(world,'failure-evidence'));fs.mkdirSync(out,{recursive:true});
const checks=[],sleep=ms=>new Promise(r=>setTimeout(r,ms)),digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function check(value,name){checks.push({name,pass:!!value});assert.ok(value,name);console.log('PASS '+name);}
async function until(fn){const deadline=Date.now()+90000;while(Date.now()<deadline){try{const r=await fn();if(r)return r;}catch{}await sleep(100);}throw Error('installed failure fixture timeout');}
async function port(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const n=server.address().port;await new Promise(r=>server.close(r));return n;}
function run(file,args){return new Promise((resolve,reject)=>{const p=spawn(file,args,{stdio:['ignore','pipe','pipe'],windowsHide:true});let log='';p.stdout.on('data',b=>log+=b);p.stderr.on('data',b=>log+=b);p.once('error',reject);p.once('exit',c=>c===0?resolve():reject(Error(log)));});}
async function connect(port){
  const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json(),tab=tabs.find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:'));if(!tab)return null;
  const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});let id=0;const waiting=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){waiting.get(m.id)?.(m);waiting.delete(m.id);}};
  return {ws,read:expression=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>reject(Error('CDP timeout')),20000);
    waiting.set(n,m=>{clearTimeout(timer);m.error||m.result?.exceptionDetails?reject(Error('CDP evaluation failed')):resolve(m.result.result.value);});ws.send(JSON.stringify({id:n,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));})};
}
(async()=>{
  let client,app,loopback;
  try{
    const setup=path.join(world,'target-setup.exe'),nsi=path.join(world,'partial-failure.nsi');
    fs.writeFileSync(nsi,`Unicode True\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "${setup}"\nSection\nSetOutPath "$INSTDIR\\resources\\app"\nFileOpen $0 "$OUTDIR\\package.json" w\nFileWrite $0 "partial write fixture"\nFileClose $0\nSetErrorLevel 9\nSectionEnd\n`);
    await run(process.env.NSIS_EXE||path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis/nsis-3.0.4.1-nsis-3.0.4.1/makensis.exe'),['/V2',nsi]);
    const release={ok:true,latestVersion:version,updateAvailable:true,release:{tag:'v'+version,notes:'Intentional partial-write installer failure acceptance.',url:`https://github.com/HYJ1817/pi-gui/releases/tag/v${version}`,assets:[{kind:'installer',name:`Pi-GUI-Setup-${version}.exe`,url:`https://github.com/HYJ1817/pi-gui/releases/download/v${version}/Pi-GUI-Setup-${version}.exe`,size:fs.statSync(setup).size,digest:'sha256:'+digest(setup)}]}};
    fs.writeFileSync(path.join(world,'release.json'),JSON.stringify(release));
    const priorReady=path.join(world,'pi-gui-updates/ready.json');
    if(fs.existsSync(priorReady))fs.renameSync(priorReady,path.join(world,'pi-gui-updates',`prior-failure-ready-${Date.now()}.json`));
    const http=await port(),cdp=await port(),data=path.join(world,'data'),profile=path.join(world,'用户 数据（测试）');
    const env={...process.env,PORT:String(http),PI_GUI_DATA:data,PI_GUI_LOG_DIR:path.join(world,'logs-failure'),PI_GUI_OPEN:'0',PI_OFFLINE:'1',PI_BIN:path.join(world,'missing-pi'),TEMP:world,TMP:world,
      APPDATA:path.join(world,'home/AppData/Roaming'),LOCALAPPDATA:path.join(world,'home/AppData/Local'),HOME:path.join(world,'home'),USERPROFILE:path.join(world,'home'),PI_UPDATE_E2E_WORLD:world,PI_UPDATE_E2E_CDP:String(cdp),PI_UPDATE_E2E_AUTOMATED_CONFIRM:'1'};
    for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_DISABLE_SANDBOX','NODE_OPTIONS','PI_CWD'])delete env[key];
    const original=digest(path.join(resources,'server.cjs')),sentinels=fs.readdirSync(data).filter(n=>n.startsWith('fixture-')).map(n=>[path.join(data,n),digest(path.join(data,n))]);
    app=spawn(path.join(install,'pi-update-7573-fixture.exe'),['--user-data-dir='+profile],{env,stdio:'ignore',windowsHide:true});const exited=new Promise(r=>app.once('exit',r));
    client=await until(()=>connect(cdp));
    await until(async()=>await client.read("Boolean(window.piGuiDesktop?.appUpdate&&document.querySelector('.update-sec'))"));
    await client.read("[...document.querySelectorAll('.update-sec button')].find(b=>b.textContent==='下载更新').click()");
    await until(async()=>(await client.read('window.piGuiDesktop.appUpdate.state()')).phase==='ready');
    check(true,'real partial-write NSIS package passes complete download and integrity checks');
    loopback=require('node:http').createServer((req,res)=>{
      res.writeHead(200,{'Content-Type':'text/html'});res.write('<!doctype html><title>Offline loading fixture</title>');
      const timer=setTimeout(()=>res.end('done'),5000);res.on('close',()=>clearTimeout(timer));
    });
    await new Promise(r=>loopback.listen(0,'127.0.0.1',r));
    await client.read('window.piGuiDesktop.browser.open()');
    await client.read(`window.piGuiDesktop.browser.navigate('http://127.0.0.1:${loopback.address().port}/')`);
    await until(async()=>(await client.read('window.piGuiDesktop.browser.agentStatus()')).loading);
    const busy=await client.read('window.piGuiDesktop.appUpdate.install()');
    check(!busy.ok&&busy.code==='busy-browser','real loading Browser refuses update before native confirmation or shutdown');
    await client.read('window.piGuiDesktop.browser.stop()');await client.read('window.piGuiDesktop.browser.close()');
    loopback.closeAllConnections();await new Promise(r=>loopback.close(r));loopback=null;
    const before=fs.readdirSync(path.join(world,'pi-gui-updates')).filter(n=>n.startsWith('install-'));
    await client.read("[...document.querySelectorAll('.update-sec button')].find(b=>b.textContent==='重启以更新').click()");
    await exited;client.ws.close();
    const result=await until(()=>{
      const run=fs.readdirSync(path.join(world,'pi-gui-updates')).find(n=>n.startsWith('install-')&&!before.includes(n));if(!run)return null;
      const file=path.join(world,'pi-gui-updates',run,'result.json');if(!fs.existsSync(file))return null;
      const r=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));return r.phase==='rolled_back'&&r.restartPid?r:null;
    });
    check(result.phase==='rolled_back','nonzero real NSIS exit after partial write restores backup and restarts');
    client=await until(()=>connect(cdp));await until(async()=>(await client.read('window.piGuiDesktop?.appUpdate?.state()'))?.completion?.phase==='failed');
    const state=await client.read('window.piGuiDesktop.appUpdate.state()');
    check(state.currentVersion===current,'restarted Electron reports actual previous version after rollback');
    check((await(await fetch(`http://127.0.0.1:${http}/api/health`)).json()).version===current,'actual previous backend remains usable');
    check(digest(path.join(resources,'server.cjs'))===original&&JSON.parse(fs.readFileSync(path.join(resources,'package.json'),'utf8')).version===current,'original program bundle and package restored');
    check(sentinels.length===7&&sentinels.every(([file,hash])=>digest(file)===hash),'all seven synthetic user data hashes preserved after failed installation');
    check((await client.read('window.piGuiDesktop.browser.open()')).ok,'browser capability available after rollback restart');await client.read('window.piGuiDesktop.browser.close()');
    await until(()=>client.read("[...document.querySelectorAll('.update-sec button')].some(b=>b.textContent==='重启以更新')&&!!document.querySelector('.update-manual-downloads')"));
    check(true,'failure offers retry and manual recovery entries after startup restoration finishes');
    fs.writeFileSync(path.join(out,'installed-failure.json'),JSON.stringify({world,previousVersion:current,failedTargetVersion:version,confirmation:'test-only response fixture',checks,result},null,2));
    await client.read('window.close()');app=null;console.log(`Installed partial-failure recovery: ${checks.length}/${checks.length}`);
  }finally{if(loopback){loopback.closeAllConnections();loopback.close();}if(client)try{await client.read('window.close()');}catch{}client?.ws.close();if(app&&app.exitCode===null)app.kill();fs.writeFileSync(path.join(out,'installed-failure-checkpoint.json'),JSON.stringify({world,checks},null,2));}
})().catch(error=>{console.error(error);process.exitCode=1;});
