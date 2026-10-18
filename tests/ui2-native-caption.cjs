/* Own-HWND Windows native capture. No capturePage or security downgrades. */
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'docs/claude-ui-redesign/ui2-followup-evidence/native-caption/owner-guard');
if(!process.versions.electron){const world=fs.mkdtempSync(path.join(os.tmpdir(),'ui2-native-')),env={...process.env,UI2_NATIVE_WORLD:world};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(require('electron'),[__filename],{env,windowsHide:false,stdio:'inherit'});child.on('error',e=>{console.error(e);process.exitCode=1;});child.on('exit',c=>{console.log('Electron native child exit '+c);process.exitCode=c??1;fs.rm(world,{recursive:true,force:true,maxRetries:30,retryDelay:100},()=>{});});
}else{
 const {app,BrowserWindow,ipcMain,nativeTheme,nativeImage,screen}=require('electron'),{createDesktopTheme}=require('../electron/theme.cjs');
 app.setPath('userData',process.env.UI2_NATIVE_WORLD);app.on('window-all-closed',()=>{});let win,harness,theme,browser,agent;const facts=[],negativeControls=[],checks=[],errors=[],started=Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms));const read=s=>win.webContents.executeJavaScript(s,true);
 async function capture(name,options={}){
 if(!options.negative){win.setAlwaysOnTop(true);win.moveTop();win.webContents.invalidate();await sleep(500);}
 const targetWindow=options.targetWindow||win,expectedPid=options.expectedPid??process.pid;
 const hwnd=targetWindow.getNativeWindowHandle().readBigUInt64LE().toString(),dest=path.join(OUT,name+'.png');
 const source=String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.Text;
public static class Own {
 [StructLayout(LayoutKind.Sequential)]public struct RECT{public int L,T,R,B;}
 [StructLayout(LayoutKind.Sequential)]public struct POINT{public int X,Y;public POINT(int x,int y){X=x;Y=y;}}
 [DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
 [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")]public static extern bool GetClientRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")]public static extern bool ClientToScreen(IntPtr h,ref POINT p);
 [DllImport("user32.dll")]public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int command);
 [DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")]public static extern int GetWindowLong(IntPtr h,int index);
 [DllImport("dwmapi.dll")]public static extern int DwmGetWindowAttribute(IntPtr h,int a,out int v,int n);
 [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr h,uint f);
 [DllImport("user32.dll")]public static extern IntPtr GetWindow(IntPtr h,uint command);
 [DllImport("user32.dll",SetLastError=true)]public static extern IntPtr OpenInputDesktop(uint f,bool i,uint a);
 [DllImport("user32.dll")]public static extern bool CloseDesktop(IntPtr h);
 [DllImport("user32.dll")]public static extern IntPtr GetThreadDesktop(uint tid);
 [DllImport("user32.dll")]public static extern IntPtr GetProcessWindowStation();
 [DllImport("kernel32.dll")]public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Unicode)]public static extern bool GetUserObjectInformation(IntPtr h,int i,StringBuilder t,int l,out int n);
 [DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint f);
 public static bool Owned(IntPtr h,uint expected){uint p;return IsWindow(h)&&GetWindowThreadProcessId(h,out p)!=0&&p==expected&&IsWindow(h);}
 public static bool VisibleOwned(IntPtr h,uint expected){int c;return Owned(h,expected)&&IsWindowVisible(h)&&DwmGetWindowAttribute(h,14,out c,4)==0&&c==0;}
 public static string Name(IntPtr h){int n;var s=new StringBuilder(256);return GetUserObjectInformation(h,2,s,512,out n)?s.ToString():"unavailable";}
 public static int Occluders(IntPtr target,int l,int t,int w,int h){int count=0;uint pid;GetWindowThreadProcessId(target,out pid);for(var p=GetWindow(target,3);p!=IntPtr.Zero;p=GetWindow(p,3)){if(!IsWindowVisible(p))continue;int cloak;DwmGetWindowAttribute(p,14,out cloak,4);if(cloak!=0)continue;uint other;GetWindowThreadProcessId(p,out other);if(other==pid)continue;RECT r;if(GetWindowRect(p,out r)&&r.L<l+w&&r.R>l&&r.T<t+h&&r.B>t)count++;}return count;}
 public static int Grid(IntPtr target,int l,int t,int w,int h){int bad=0;for(int y=0;y<h;y+=16)for(int x=0;x<w;x+=16)if(GetAncestor(WindowFromPoint(new POINT(l+x,t+y)),2)!=target)bad++;return bad;}
}
'@
[void][Own]::SetProcessDpiAwarenessContext([IntPtr](-4))
$target=[IntPtr]${hwnd};$ownerPid=[uint32]0;[void][Own]::GetWindowThreadProcessId($target,[ref]$ownerPid)
$visibleBefore=[Own]::IsWindowVisible($target);$showReturn=$false;$focusReturn=$false
if($ownerPid -eq ${expectedPid}){if(-not $visibleBefore){$showReturn=[Own]::ShowWindow($target,5);[void][Own]::ShowWindow($target,5)};Start-Sleep -Milliseconds 300}
$cloaked=0;$dwmResult=[Own]::DwmGetWindowAttribute($target,14,[ref]$cloaked,4);$style=[Own]::GetWindowLong($target,-16)
$foreground=[Own]::GetForegroundWindow();$foregroundPid=[uint32]0;[void][Own]::GetWindowThreadProcessId($foreground,[ref]$foregroundPid)
$desktop=[Own]::OpenInputDesktop(0,$false,1);$desktopError=if($desktop -eq [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::GetLastWin32Error()}else{0}
$inputName=if($desktop -ne [IntPtr]::Zero){[Own]::Name($desktop)}else{'unavailable'}
$threadName=[Own]::Name([Own]::GetThreadDesktop([Own]::GetCurrentThreadId()));$stationName=[Own]::Name([Own]::GetProcessWindowStation())
$rect=New-Object Own+RECT;[void][Own]::GetWindowRect($target,[ref]$rect)
$client=New-Object Own+RECT;[void][Own]::GetClientRect($target,[ref]$client)
$point=New-Object Own+POINT(0,0);[void][Own]::ClientToScreen($target,[ref]$point)
$width=$client.R;$height=$client.B;$samples=0;$occluded=0
$safe=[Own]::VisibleOwned($target,${expectedPid}) -and ($desktop -ne [IntPtr]::Zero) -and ($inputName -eq $threadName)
$externalIntersections=-1;$afterIntersections=-1;$afterGrid=-1
if($safe){$externalIntersections=[Own]::Occluders($target,($point.X+4),($point.Y+4),($width-8),($height-8));$occluded=[Own]::Grid($target,($point.X+4),($point.Y+4),($width-8),($height-8));$samples=[Math]::Ceiling(($width-8)/16)*[Math]::Ceiling(($height-8)/16);$safe=($occluded -eq 0) -and ($externalIntersections -eq 0)}
$saved=$false;$method='none';$captureError='';$copyCalls=0;$printCalls=0
$copyOwnerBefore=$false;$copyOwnerAfter=$false;$copyVisibleAfter=$false;$copyOwnerBeforeSave=$false;$printOwnerBefore=$false;$printOwnerAfter=$false;$printOwnerBeforeSave=$false;$copyRejection='';$printRejection=''
$copyEnabled=${options.mode==='print'?'$false':'$true'}
if($copyEnabled){$copyOwnerBefore=[Own]::VisibleOwned($target,${expectedPid});if(-not $copyOwnerBefore){$copyRejection='invalid_hwnd_owner_or_visibility'}elseif(-not $safe){$copyRejection='desktop_or_owned_coverage_unproven'}}else{$copyRejection='path_disabled_for_negative_control'}
if($copyEnabled -and $safe -and $copyOwnerBefore){$bitmap=New-Object Drawing.Bitmap(($width-8),($height-8));$g=[Drawing.Graphics]::FromImage($bitmap)
 try{if(-not [Own]::VisibleOwned($target,${expectedPid})){throw 'copy_preflight_identity_changed'};$copyCalls++;$g.CopyFromScreen(($point.X+4),($point.Y+4),0,0,$bitmap.Size,[Drawing.CopyPixelOperation]::SourceCopy);$copyOwnerAfter=[Own]::Owned($target,${expectedPid});$copyVisibleAfter=[Own]::VisibleOwned($target,${expectedPid});if(-not $copyOwnerAfter -or -not $copyVisibleAfter){throw 'copy_after_identity_or_visibility_changed'};$afterIntersections=[Own]::Occluders($target,($point.X+4),($point.Y+4),($width-8),($height-8));$afterGrid=[Own]::Grid($target,($point.X+4),($point.Y+4),($width-8),($height-8));if($afterIntersections -ne 0 -or $afterGrid -ne 0){throw 'owned_coverage_changed_during_capture'};$copyOwnerBeforeSave=[Own]::VisibleOwned($target,${expectedPid});if(-not $copyOwnerBeforeSave){throw 'copy_save_identity_or_visibility_changed'};$bitmap.Save('${dest}',[Drawing.Imaging.ImageFormat]::Png);$saved=$true;$method='CopyFromScreen own client inset4, before/after z-order and hit-grid verified'}catch{$captureError=$_.Exception.Message;$copyRejection=$captureError}finally{$g.Dispose();$bitmap.Dispose()}}
if(-not $saved){$printOwnerBefore=[Own]::Owned($target,${expectedPid});if(-not $printOwnerBefore){$printRejection='invalid_hwnd_or_owner'}else{
 $bitmap=New-Object Drawing.Bitmap(($rect.R-$rect.L),($rect.B-$rect.T));$g=[Drawing.Graphics]::FromImage($bitmap);$dc=$g.GetHdc();$printed=$false
 try{if([Own]::Owned($target,${expectedPid})){$printCalls++;$printed=[Own]::PrintWindow($target,$dc,2)}else{$printRejection='print_preflight_identity_changed'}}finally{$g.ReleaseHdc($dc);$g.Dispose()}
 $printOwnerAfter=[Own]::Owned($target,${expectedPid});if($printed -and $printOwnerAfter){$printOwnerBeforeSave=[Own]::Owned($target,${expectedPid});if($printOwnerBeforeSave){$bitmap.Save('${dest}',[Drawing.Imaging.ImageFormat]::Png);$method='PrintWindow exact own HWND';$saved=$true}else{$printRejection='print_save_identity_changed'}}elseif(-not $printOwnerAfter){$printRejection='print_after_identity_changed'}else{$printRejection='print_api_failed'};$bitmap.Dispose()
}}
if($desktop -ne [IntPtr]::Zero){[void][Own]::CloseDesktop($desktop)}
[ordered]@{ownerPid=$ownerPid;expectedPid=${expectedPid};sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;userInteractive=[Environment]::UserInteractive;foregroundOwned=($foreground -eq $target);foregroundPid=$foregroundPid;visibleBefore=$visibleBefore;showWindowPreviousVisible=$showReturn;setForegroundReturn=$focusReturn;visible=[Own]::IsWindowVisible($target);windowStyle=$style;dwmCloaked=$cloaked;dwmResult=$dwmResult;inputDesktop=$inputName;threadDesktop=$threadName;windowStation=$stationName;openInputDesktopError=$desktopError;safeForScreenCopy=$safe;gridSamples=$samples;occludedSamples=$occluded;externalIntersections=$externalIntersections;afterIntersections=$afterIntersections;afterGrid=$afterGrid;clientOrigin=@($point.X,$point.Y);clientSize=@($width,$height);windowRect=@($rect.L,$rect.T,$rect.R,$rect.B);method=$method;saved=$saved;captureError=$captureError;copyCalls=$copyCalls;printCalls=$printCalls;targetIsWindow=[Own]::IsWindow($target);copyOwnerBeforeSave=$copyOwnerBeforeSave;printOwnerBeforeSave=$printOwnerBeforeSave;copyOwnerBefore=$copyOwnerBefore;copyOwnerAfter=$copyOwnerAfter;copyVisibleAfter=$copyVisibleAfter;printOwnerBefore=$printOwnerBefore;printOwnerAfter=$printOwnerAfter;copyRejection=$copyRejection;printRejection=$printRejection}|ConvertTo-Json -Compress
`;
 const audit=await new Promise((resolve,reject)=>{const c=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);const t=setTimeout(()=>{c.kill();reject(Error('native helper timeout'));},20000);c.on('exit',code=>{clearTimeout(t);if(code)return reject(Error(err.slice(-2000)));try{resolve(JSON.parse(out.trim()));}catch{reject(Error('native audit invalid '+err.slice(-1000)));}});});
 if(options.negative){const imageExists=fs.existsSync(dest);const pass=audit.targetIsWindow&&audit.visible&&audit.ownerPid===process.pid&&audit.ownerPid!==expectedPid&&!audit.saved&&!imageExists&&audit.copyCalls===0&&audit.printCalls===0&&!audit.copyOwnerBefore&&!audit.printOwnerBefore;const control={name,requestedPath:options.mode,ownFixtureTarget:true,...audit,imageExists};negativeControls.push(control);checks.push({label:name+' rejects own-fixture HWND with mismatched expected PID before both capture APIs and saving',pass,detail:control});console.log('NEGATIVE '+JSON.stringify(control));return control;}
 const fact={name,...audit,electronVisible:win.isVisible(),electronFocused:win.isFocused(),theme:theme.snapshot(),zoom:win.webContents.getZoomFactor(),maximized:win.isMaximized(),displayScale:screen.getDisplayMatching(win.getBounds()).scaleFactor,rightPane:await read(`!document.querySelector('#rightPane').hidden`),renderer:await read(`(()=>{const p=document.querySelector('#rightPane');return {theme:document.documentElement.dataset.theme,paneHidden:p.hidden,paneRect:p.getBoundingClientRect().toJSON(),paneMode:p.dataset.mode,paneSurface:p.dataset.surface,paneTitle:p.querySelector('h3')?.textContent,surfaces:['.stage-head','.rail-head','.rp-titlebar'].map(selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect();return {selector,rect:r.toJSON(),color:getComputedStyle(e).backgroundColor}})}})()`),file:audit.saved?name+'.png':null};
 if(audit.saved){const img=nativeImage.createFromPath(dest),bytes=img.toBitmap(),size=img.getSize(),colors=new Set();for(let i=0;i<bytes.length&&colors.size<100000;i+=4)colors.add(bytes[i]+','+bytes[i+1]+','+bytes[i+2]);fact.image=size;fact.uniqueColors=colors.size;fact.available=colors.size>=16;const pixel=(x,y)=>{const i=(Math.max(0,Math.min(size.height-1,y))*size.width+Math.max(0,Math.min(size.width-1,x)))*4;return[bytes[i+2],bytes[i+1],bytes[i]]};fact.captionPixels={background:pixel(size.width-165,15),minimize:pixel(size.width-115,15),maximize:pixel(size.width-70,15),close:pixel(size.width-25,15)};fact.reason=fact.available?'nonuniform native own-window image':'uniform OS capture; native caption not proven';}else{fact.available=false;fact.reason='no owned native capture';}
 if(fact.available){
  const img=nativeImage.createFromPath(dest),size=img.getSize(),bytes=img.toBitmap(),scale=fact.displayScale;
  const expected=fact.theme.resolved==='dark'?[17,17,17]:[251,251,249],symbol=fact.theme.resolved==='dark'?[195,194,183]:[82,81,78];
  const buttonWidth=Math.round(46*scale),rightInset=audit.method.startsWith('CopyFromScreen')?-4:Math.round(7*scale),centerY=audit.method.startsWith('CopyFromScreen')?Math.round(23*scale)-4:Math.round((fact.maximized?31:23)*scale);
  fact.captionGlyphs=[];
  for(let b=0;b<3;b++){
   const centerX=size.width-rightInset-Math.round((b+.5)*buttonWidth);let glyph=0,bg=0;
   for(let y=centerY-13;y<=centerY+13;y++)for(let x=centerX-15;x<=centerX+15;x++){
    const i=(y*size.width+x)*4,rgb=[bytes[i+2],bytes[i+1],bytes[i]];
    if(rgb.every((v,k)=>Math.abs(v-symbol[k])<=24))glyph++;
    if(rgb.every((v,k)=>Math.abs(v-expected[k])<=3))bg++;
   }
   fact.captionGlyphs.push({button:['close','maximizeOrRestore','minimize'][b],glyphPixels:glyph,backgroundPixels:bg,center:[centerX,centerY]});
  }
  
  const offset=audit.method.startsWith('CopyFromScreen')?[-4,-4]:[audit.clientOrigin[0]-audit.windowRect[0],audit.clientOrigin[1]-audit.windowRect[1]];
  fact.titlebarPixels=fact.renderer.surfaces.filter(s=>s.rect.width>0&&s.rect.height>0).map(s=>{
   const x=Math.round((s.rect.x+Math.min(10,s.rect.width/2))*scale*fact.zoom+offset[0]),y=Math.round((s.rect.y+5)*scale*fact.zoom+offset[1]),i=(y*size.width+x)*4;
   const actual=[bytes[i+2],bytes[i+1],bytes[i]],css=s.color.match(/[0-9.]+/g)?.slice(0,3).map(Number);
   return {selector:s.selector,point:[x,y],actual,css,pass:css&&actual.every((v,k)=>Math.abs(v-css[k])<=3)&&actual.every((v,k)=>Math.abs(v-expected[k])<=3)};
  });
  checks.push({label:name+' native screen pixels match production stage rail and visible pane titlebar theme',pass:fact.renderer.theme===fact.theme.resolved&&fact.titlebarPixels.every(p=>p.pass),detail:fact.titlebarPixels});
  if(name.endsWith('right-pane'))checks.push({label:name+' production right pane open with real bounds and surface',pass:!fact.renderer.paneHidden&&fact.renderer.paneRect.width>100&&fact.renderer.paneRect.height>100&&fact.renderer.paneSurface===(name.includes('browser-right-pane')?'browser':'changes'),detail:fact.renderer});
  const captionFile=name+'-caption.png';fs.writeFileSync(path.join(OUT,captionFile),img.crop({x:size.width-Math.round(150*scale),y:0,width:Math.round(150*scale),height:Math.round(55*scale)}).toPNG());fact.captionFile=captionFile;
  checks.push({label:name+' own HWND visible, native glyphs and expected theme background',pass:fact.ownerPid===fact.expectedPid&&fact.visible&&fact.captionGlyphs.length===3&&fact.captionGlyphs.every(g=>g.glyphPixels>=4&&g.backgroundPixels>=300),detail:fact.captionGlyphs});
 }
 facts.push(fact);console.log(JSON.stringify(fact));return fact;
 }
 async function main(){fs.mkdirSync(OUT,{recursive:true});await app.whenReady();harness=spawn(process.execPath,[path.join(ROOT,'tests/visual-harness.cjs')],{cwd:process.env.UI2_NATIVE_WORLD,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',HARNESS_PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});const origin=await new Promise((resolve,reject)=>{let buf='';const t=setTimeout(()=>reject(Error('harness startup')),15000);harness.stdout.on('data',c=>{buf+=c;const m=buf.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(t);resolve(m[0]);}});});
 browser=require('../electron/browser-view.cjs').createBrowserController({origin,getWindow:()=>win,ipcMain});browser.register();agent=require('../electron/browser-agent-host.cjs').createBrowserAgentHost({browser,origin,getWindow:()=>win,ipcMain,extensionPath:path.join(ROOT,'extensions/pi-gui-browser/index.js')});await agent.start();theme=createDesktopTheme({ipcMain,nativeTheme,getWindow:()=>win,origin,preferenceFile:path.join(process.env.UI2_NATIVE_WORLD,'theme.json')});theme.register();win=new BrowserWindow({width:1200,height:900,useContentSize:true,show:false,titleBarStyle:'hidden',...theme.windowOptions(),webPreferences:{preload:path.join(ROOT,'electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,additionalArguments:['--pi-gui-theme-bridge']}});await win.loadURL(origin);win.showInactive();await sleep(1200);
 const negativeWindow=new BrowserWindow({show:false,width:300,height:200,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
 try{negativeWindow.showInactive();await sleep(150);await capture('negative-copy-owner',{negative:true,targetWindow:negativeWindow,expectedPid:process.pid+1,mode:'copy'});await capture('negative-print-owner',{negative:true,targetWindow:negativeWindow,expectedPid:process.pid+1,mode:'print'});}finally{negativeWindow.destroy();}
 const first=await capture('dark-initial');if(!first.available&&!first.safeForScreenCopy){facts.push({name:'matrix-not-run',available:false,reason:'Initial exact own HWND capture uniform; desktop ownership gate unavailable. Bounded stop.',requestedMatrix:'dark/light switch, maximize/restore, zoom .8/1.25/1.5, right pane'});return;}
 for(const mode of ['light','dark']){await read(`window.piGuiDesktop.theme.set(${JSON.stringify(mode)})`);await sleep(200);for(const zoom of [.8,1,1.25,1.5]){win.webContents.setZoomFactor(zoom);await sleep(200);await capture(mode+'-zoom-'+zoom);}win.webContents.setZoomFactor(1);win.maximize();await sleep(300);await capture(mode+'-maximized');win.unmaximize();await sleep(300);await capture(mode+'-restored');await read(`document.querySelector('#navChanges').click()`);await sleep(300);await capture(mode+'-right-pane');await read(`document.querySelector('#rightPaneClose').click()`);await read(`document.querySelector('#btnBrowser').click()`);await sleep(400);await capture(mode+'-browser-right-pane');await read(`document.querySelector('#browserClose').click()`);}
 }
 const timeout=setTimeout(()=>{console.error('native caption timeout');app.exit(1);},180000);main().catch(e=>errors.push(e.stack)).finally(async()=>{fs.mkdirSync(OUT,{recursive:true});const expected=['dark-initial',...['light','dark'].flatMap(mode=>[...[.8,1,1.25,1.5].map(z=>mode+'-zoom-'+z),mode+'-maximized',mode+'-restored',mode+'-right-pane',mode+'-browser-right-pane'])];
 const names=facts.map(f=>f.name);
 checks.push({label:'Complete 17 unique expected native scenes executed',pass:facts.length===17&&new Set(names).size===17&&expected.every(n=>names.includes(n)),detail:{expected,actual:names}});
 checks.push({label:'All 17 native scenes available with allowed owned-window capture methods',pass:facts.length===17&&facts.every(f=>f.available&&f.saved&&f.file&&f.image?.width>100&&f.image?.height>100&&['PrintWindow exact own HWND','CopyFromScreen own client inset4, before/after z-order and hit-grid verified'].includes(f.method)),detail:facts.map(f=>({name:f.name,available:f.available,method:f.method}))});
 checks.push({label:'All scenes include stage and rail pixel samples; visible panes include pane sample',pass:facts.length===17&&facts.every(f=>['.stage-head','.rail-head',...(!f.renderer?.paneHidden?['.rp-titlebar']:[])].every(selector=>f.titlebarPixels?.some(p=>p.selector===selector&&p.pass))),detail:facts.map(f=>({name:f.name,samples:f.titlebarPixels?.map(p=>p.selector)}))});
 const panes=['light-right-pane','light-browser-right-pane','dark-right-pane','dark-browser-right-pane'];
 checks.push({label:'Four expected right-pane scenes match real changes/browser surfaces',pass:panes.every(name=>{const f=facts.find(f=>f.name===name);return f?.available&&!f.renderer.paneHidden&&f.renderer.paneRect.width>100&&f.renderer.paneRect.height>100&&f.renderer.paneSurface===(name.includes('browser')?'browser':'changes');}),detail:panes.map(name=>({name,renderer:facts.find(f=>f.name===name)?.renderer}))});
 checks.push({label:'All successful captures revalidate native HWND PID at API and save boundaries',pass:facts.length===17&&facts.every(f=>f.method.startsWith('CopyFromScreen')?f.copyCalls===1&&f.copyOwnerBefore&&f.copyOwnerAfter&&f.copyVisibleAfter&&f.copyOwnerBeforeSave:f.printCalls===1&&f.printOwnerBefore&&f.printOwnerAfter&&f.printOwnerBeforeSave),detail:facts.map(f=>({name:f.name,method:f.method,copyOwnerBefore:f.copyOwnerBefore,copyOwnerAfter:f.copyOwnerAfter,copyVisibleAfter:f.copyVisibleAfter,copyOwnerBeforeSave:f.copyOwnerBeforeSave,printOwnerBeforeSave:f.printOwnerBeforeSave,printOwnerBefore:f.printOwnerBefore,printOwnerAfter:f.printOwnerAfter}))});
 const available=facts.filter(f=>f.available).length,failed=checks.filter(c=>!c.pass).length,exitCode=errors.length||failed?1:available?0:2;const report={status:errors.length?'error':available?'native-images-produced':'blocked-no-capturable-owned-desktop',exitCode,available,passed:checks.length-failed,failed,checks,facts,negativeControls,errors,durationMs:Date.now()-started,versions:{electron:process.versions.electron,chrome:process.versions.chrome},security:{contextIsolation:true,nodeIntegration:false,sandbox:true,noSandboxFlag:false},limits:'No capturePage, no external program operation, no security/theme/DPI OS changes. App zoom is not OS DPI.'};fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));console.log('NATIVE '+report.status);clearTimeout(timeout);await agent?.stop?.();browser?.destroy?.();theme?.dispose();win?.setAlwaysOnTop(false);win?.destroy();harness?.kill();await sleep(100);app.exit(exitCode);});
}
