# 本次 TEMP 探针原文

仅为本次证据留档；路径绑定本轮 TEMP 目录。正式复现先替换输出目录和仓库路径，保持临时数据隔离。

```
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),{spawn,execFileSync}=require('node:child_process'),crypto=require('node:crypto');
const out=path.join(__dirname,'packaged-gui-verified'),appRoot=path.join(__dirname,'rebuilt/dist-app/Pi GUI-win32-x64'),exe=path.join(appRoot,'Pi GUI.exe'),repo='C:/pi-GUI';
fs.mkdirSync(out,{recursive:true});const world=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'pi-final-packaged-')),home=path.join(world,'home'),data=path.join(world,'data'),project=path.join(world,'project');for(const dir of[home,data,project])fs.mkdirSync(dir,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const port=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;};
let child,ws;const rows=[],shots=[],requests=new Map();let seq=0;
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function check(name,passed,detail){rows.push({name,passed,detail});console.log((passed?'PASS ':'FAIL ')+name);if(!passed)throw Error(name);}
async function call(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{requests.delete(id);reject(Error('CDP timeout '+method))},10000);requests.set(id,{resolve:x=>{clearTimeout(timer);resolve(x)},reject:x=>{clearTimeout(timer);reject(x)}});ws.send(JSON.stringify({id,method,params}));});}
async function read(expression){const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error('Packaged renderer evaluation failed at '+expression.slice(0,90));return r.result.value;}
async function until(fn,label){for(let i=0;i<160;i++){if(await fn())return;await sleep(100);}throw Error('Timeout '+label);}
async function click(selector){await read('document.querySelector('+JSON.stringify(selector)+').scrollIntoView({block:"nearest"})');const p=await read('(()=>{let e=document.querySelector('+JSON.stringify(selector)+'),r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,visible:e.checkVisibility()}})()');check('visible packaged action '+selector,p.visible);await call('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});await sleep(220);}
async function shot(name){await sleep(220);const r=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));shots.push({file:name+'.png',viewport:await read('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})')});}
(async()=>{
 const files=execFileSync('git',['ls-files','public'],{cwd:repo,encoding:'utf8'}).trim().split('\n');const hashes=files.map(file=>({file,source:hash(path.join(repo,file)),packaged:hash(path.join(appRoot,'resources/app',file))}));check('all production public files match the rebuilt package',hashes.every(x=>x.source===x.packaged),{files:hashes.length});fs.writeFileSync(path.join(out,'asset-hashes.json'),JSON.stringify(hashes,null,2));
 fs.writeFileSync(path.join(data,'projects.json'),JSON.stringify({active:project,items:[{path:project,name:'Offline GUI fixture'}]}));fs.writeFileSync(path.join(project,'README.md'),'# Offline packaged GUI fixture\n');
 const bin=path.join(world,'pi.cmd');fs.writeFileSync(bin,'@echo off\r\n"'+process.execPath+'" "'+path.join(repo,'tests/fixtures/candidate-pi.cjs')+'" %*\r\n');
 const backendPort=await port(),debugPort=await port();const env={...process.env,PORT:String(backendPort),PI_GUI_DATA:data,PI_GUI_OPEN:'0',PI_GUI_OFFLINE:'1',PI_OFFLINE:'1',PI_CWD:project,PI_BIN:bin,PI_CODING_AGENT_DIR:path.join(home,'agent'),HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local')};delete env.ELECTRON_RUN_AS_NODE;
 child=spawn(exe,['--user-data-dir='+path.join(world,'profile'),'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+debugPort,'--force-device-scale-factor=1.5','--disable-background-networking'],{cwd:world,env,windowsHide:false,stdio:['ignore','ignore','pipe']});child.stderr.on('data',()=>{});
 let target;await until(async()=>{try{target=(await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json()).find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:'+backendPort));return !!target;}catch{return false;}},'actual packaged window');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});ws.addEventListener('message',event=>{const r=JSON.parse(event.data),p=requests.get(r.id);if(p){requests.delete(r.id);r.error?p.reject(Error(r.error.message)):p.resolve(r.result)}});
 await call('Runtime.enable');await until(()=>read('!!document.querySelector("#navGlobalMore")&&!!window.piGuiDesktop'),'production page/preload');
 await read('(async()=>{const u=await import("/update.js");u.cancelUpdateAuto()})()');
 const hwnd=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','(Get-Process -Id '+child.pid+').MainWindowHandle.ToInt64()'],{encoding:'utf8',windowsHide:true}).trim();
 const winApi = [
'Add-Type -TypeDefinition @'+String.fromCharCode(39),
'using System;using System.Runtime.InteropServices;',
'public static class FixWindow {',
'[StructLayout(LayoutKind.Sequential)]public struct R{public int L,T,Ri,B;}',
'[DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr p);',
'[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r);',
'[DllImport("user32.dll")]public static extern bool GetClientRect(IntPtr h,out R r);',
'[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);',
'[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int z,uint f);',
'[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);',
'}',
String.fromCharCode(39)+'@',
'[void][FixWindow]::SetProcessDpiAwarenessContext([IntPtr](-4))'
].join('\n');
 const resizeCmd=winApi+"\n$target=[IntPtr]::new("+hwnd+");$ownerPid=0;[void][FixWindow]::GetWindowThreadProcessId($target,[ref]$ownerPid);if($ownerPid -ne "+child.pid+"){throw 'window identity'};$outer=New-Object FixWindow+R;$inner=New-Object FixWindow+R;[void][FixWindow]::GetWindowRect($target,[ref]$outer);[void][FixWindow]::GetClientRect($target,[ref]$inner);[void][FixWindow]::SetWindowPos($target,[IntPtr](-1),30,30,(1808+$outer.Ri-$outer.L-$inner.Ri),(1205+$outer.B-$outer.T-$inner.B),64)";
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(resizeCmd,'utf16le').toString('base64')],{windowsHide:true});await sleep(300);

 check('packaged preload uses context isolation without renderer Node',await read('typeof require==="undefined"&&!!window.piGuiDesktop.theme'));
 await read('(async()=>{const t=await import("/theme.js");await t.setThemePreference("dark")})()');await shot('p01-main-dark');
 await click('#btnSidebarCollapse');await shot('p02-main-collapsed-dark');await click('#btnSidebarExpand');
 await read('(async()=>{const t=await import("/theme.js");await t.setThemePreference("light")})()');await shot('p03-main-light');
 await click('#navGlobalMore');await click('#navAppearance');check('packaged appearance keeps real actions and removes nested card',await read('document.querySelector(".settings-detail-card > .modal-actions").checkVisibility()&&getComputedStyle(document.querySelector(".appearance-body")).borderTopWidth==="0px"'));await shot('p04-appearance-light');
 await click('#navProviders');await click('.prov-btn-main');check('packaged provider Save and Cancel are visible',await read('[...document.querySelectorAll(".settings-detail-card>.modal-actions button")].length===2&&[...document.querySelectorAll(".settings-detail-card>.modal-actions button")].every(e=>e.checkVisibility())'));await shot('p05-provider-form-light');await click('.settings-detail-card>.modal-actions button:first-child');
 await click('#navMcp');check('packaged MCP has correct unique navigation projection',await read('document.querySelector("#navMcp").getAttribute("aria-current")==="page"'));await shot('p06-mcp-light');
 await click('#settingsReturn');await click('#btnWorkPanel');await click('.work-panel-launcher-row[data-tool="btnBrowser"]');await until(()=>read('!!document.querySelector(".browser-empty")'),'packaged empty browser');check('packaged Browser empty guidance is visible in light theme',await read('document.querySelector(".browser-empty").checkVisibility()'));await shot('p07-browser-empty-light');
 await read('(async()=>{const t=await import("/theme.js");await t.setThemePreference("dark")})()');await shot('p08-browser-empty-dark');
 const helper=fs.readFileSync(path.join(__dirname,'native-print.ps1'),'utf8');const dest=path.join(out,'p08-browser-empty-dark-native.png').replaceAll("'","''");const command="& {\n"+helper+"\n} -WindowHandle '"+hwnd+"' -ExpectedPid "+child.pid+" -OutputFile '"+dest+"'";
 const capture=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true}));fs.writeFileSync(path.join(out,'native-capture.json'),JSON.stringify(capture,null,2));check('packaged native caption captured from exact owned HWND',capture.saved,capture);
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(winApi+"\n[void][FixWindow]::PostMessage([IntPtr]::new("+hwnd+"),16,[IntPtr]::Zero,[IntPtr]::Zero)",'utf16le').toString('base64')],{windowsHide:true});ws.close();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,15000)});check('actual packaged application exits after closing its own window',child.exitCode===0);
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({executable:exe,executableSha256:hash(exe),world,normalSandbox:true,fixture:'actual packaged main/preload/server/public, fake Pi, TEMP project and profile, loopback CDP only',rows,shots,exitCode:child.exitCode},null,2));console.log('Packaged GUI '+rows.length+'/'+rows.length);
})().catch(error=>{console.error(error.message);fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({error:error.message,rows,shots},null,2));try{ws?.close();child?.kill()}catch{}process.exitCode=1;});

```
