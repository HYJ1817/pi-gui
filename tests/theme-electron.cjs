/* UI-1 actual Electron presentation acceptance, offline fixture only.
 * Run: node tests/theme-electron.cjs
 * The width/sidebar/pane matrix is Cartesian for light/dark at zoom=1;
 * additional zoom/system/reload/window-state cases are explicitly listed.
 * NativeTheme simulations change this Electron application's themeSource only.
 * They do not modify Windows settings or prove OS DPI / real system switching.
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.UI_THEME_EVIDENCE || path.join(ROOT, 'docs/claude-ui-redesign/ui-1-evidence/electron');
if (!process.versions.electron) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-theme-electron-'));
  const env = { ...process.env, UI1_THEME_WORLD: world }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, '--no-sandbox', '--in-process-gpu'], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    process.exitCode = code ?? 1;
    fs.rm(world, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }, error => { if (error) console.error('Fixture cleanup: ' + error.code); });
  });
} else {
  const { app, BrowserWindow, ipcMain, nativeTheme, desktopCapturer, screen } = require('electron');
  const { createDesktopTheme, THEME_PALETTE } = require('../electron/theme.cjs');
  const { createBrowserController } = require('../electron/browser-view.cjs');
  const { createBrowserAgentHost } = require('../electron/browser-agent-host.cjs');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const screenshots = [], facts = [], checks = [], errors = [], consoleErrors = [], frameSamples = [], overlayCalls = [], nativeWindowSnapshots = [];
  const started = Date.now();
  let win, harness, fixture, theme, controller, agent, origin, lastOverlay, exitCode = 0;
  const watchdog = setTimeout(() => { console.error('Theme Electron timed out after 12 minutes'); app.exit(1); }, 720000);
  app.on('window-all-closed', () => {});
  app.setPath('userData', process.env.UI1_THEME_WORLD);
  const preferenceFile = path.join(process.env.UI1_THEME_WORLD, 'ui-theme.json');
  const check = (ok, label, detail) => {
    checks.push({ label, pass: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
    if (!ok) { errors.push(label); console.error('FAIL ' + label + (detail === undefined ? '' : ': ' + JSON.stringify(detail))); }
  };
  const read = expression => win.webContents.executeJavaScript(expression);
  async function waitFor(expression, label) {
    for (let i = 0; i < 100; i++) { if (await read(expression).catch(() => false)) return; await sleep(50); }
    throw new Error('Timeout: ' + label);
  }
  async function pointer(selector) {
    const point = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const b=e.getBoundingClientRect();return b.width&&b.height?{x:b.x+b.width/2,y:b.y+b.height/2}:null})()`);
    if (!point) throw new Error('Invisible target: ' + selector);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
    }
    await sleep(100);
  }
  async function key(key, code, vk, modifiers = 0) {
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(100);
  }
  async function openAppearance() {
    await pointer('#navGlobalMore'); await waitFor(`!document.querySelector('#globalMoreMenu').hidden`, 'settings menu');
    await pointer('#navAppearance'); await waitFor(`!!document.querySelector('.appearance-body select')`, 'appearance modal');
    check(await read(`document.activeElement.matches('.appearance-body select')`), 'appearance starts on theme select');
  }
  async function selectTheme(mode, close = true) {
    await openAppearance();
    // Actual key events on the native select; no JS assignment or synthetic change.
    await key('Home', 'Home', 36);
    for (let i = 0; i < ['dark', 'light', 'system'].indexOf(mode); i++) await key('ArrowDown', 'ArrowDown', 40);
    await key('Enter', 'Enter', 13);
    await waitFor(`document.documentElement.dataset.themePreference===${JSON.stringify(mode)}`, 'theme selection ' + mode);
    check(theme.snapshot().preference === mode, 'native controller receives real select ' + mode);
    if (close) {
      await key('Escape', 'Escape', 27);
      check(await read(`document.querySelector('#modal').hidden && document.activeElement.id==='navGlobalMore'`), 'appearance Escape restores Settings focus');
    }
  }
  async function setSidebar(open) {
    const visible = await read(`!document.querySelector('#projectSidebar').hidden`);
    if (visible !== open) await pointer(open ? '#btnSidebarExpand' : '#btnSidebarCollapse');
    await waitFor(`document.querySelector('#projectSidebar').hidden===${!open}`, 'sidebar state');
  }
  async function closePane() {
    if (!await read(`document.querySelector('#rightPane').hidden`)) {
      const browser = await read(`document.querySelector('#rightPane').dataset.surface==='browser'`);
      await pointer(browser ? '#browserClose' : '#rightPaneClose');
      check(await read(`document.activeElement.id===${JSON.stringify(browser ? 'btnBrowser' : 'navChanges')}`),'pane close returns trigger focus');
    }
    await waitFor(`document.querySelector('#rightPane').hidden`, 'pane closed');
  }
  async function pane(mode) {
    await closePane();
    if (mode === 'closed') return;
    await pointer(mode === 'changes' ? '#navChanges' : '#btnBrowser');
    await waitFor(mode === 'changes' ? `!!document.querySelector('#rightPane .chg-row')` : `!!document.querySelector('#browserAddress')`, mode + ' pane');
    if (mode === 'browser') {
      await pointer('#browserAddress'); await key('a', 'KeyA', 65, 2);
      await win.webContents.debugger.sendCommand('Input.insertText', { text: `http://127.0.0.1:${fixture.address().port}/` });
      await key('Enter', 'Enter', 13);
      for (let i = 0; i < 100 && controller.getWebContents()?.getTitle() !== 'Theme local preview'; i++) await sleep(50);
      check(controller.getWebContents()?.getTitle() === 'Theme local preview', 'actual Browser loads loopback fixture');
    }
    await sleep(140);
  }
  const stateExpression = `(()=>{
    const q=s=>document.querySelector(s), box=s=>{const e=q(s);if(!e)return null;const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}};
    const color=s=>q(s)?getComputedStyle(q(s)).backgroundColor:null;
    return {theme:document.documentElement.dataset.theme,preference:document.documentElement.dataset.themePreference,inner:[innerWidth,innerHeight],dpr:devicePixelRatio,scroll:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],stage:box('.stage-head'),rail:box('.rail-head'),global:box('.global-rail'),project:box('#projectSidebar'),pane:box('#rightPane'),paneHidden:q('#rightPane').hidden,paneMode:q('#rightPane').dataset.mode,paneSurface:q('#rightPane').dataset.surface,sidebarHidden:q('#projectSidebar').hidden,stageColor:color('.stage-head'),railColor:color('.rail-head'),paneColor:color('.rp-titlebar'),canvasColor:color('#workspace'),modalBackdrop:!q('#modal').hidden?color('#modal'):null,active:document.activeElement?.id,captionReserve:innerWidth-q('.head-right').getBoundingClientRect().right,nav:[...document.querySelectorAll('.global-rail button[id],#projectSidebar .nav-item[id],#globalMoreMenu button[id]')].map(e=>e.id).sort(),firstFrames:window.__ui1FirstFrames||[]};
  })()`;
  function rgbHex(hex) { const v=hex.replace('#',''); return `rgb(${parseInt(v.slice(0,2),16)}, ${parseInt(v.slice(2,4),16)}, ${parseInt(v.slice(4,6),16)})`; }
  async function shot(name, context = {}) {
    await sleep(120);
    const f = await read(stateExpression), expected = THEME_PALETTE[theme.snapshot().resolved];
    const nativeImage = await win.webContents.capturePage(), imageSize = nativeImage.getSize();
    const bitmap = nativeImage.toBitmap();
    function pixel(x,y) {
      const xx=Math.max(0,Math.min(imageSize.width-1,Math.round(x*imageSize.width/f.inner[0]))), yy=Math.max(0,Math.min(imageSize.height-1,Math.round(y*imageSize.height/f.inner[1])));
      const off=(yy*imageSize.width+xx)*4;return [bitmap[off+2],bitmap[off+1],bitmap[off]];
    }
    const expectedRgb=expected.background.match(/\w\w/g).map(x=>parseInt(x,16));
    // A real modal backdrop composites over the titlebar; compare the composed
    // color in that case rather than treating its intentional dimming as drift.
    const backdrop=f.modalBackdrop?.match(/[\d.]+/g)?.map(Number);
    const composedRgb=backdrop?expectedRgb.map((v,i)=>Math.round(v*(1-backdrop[3])+backdrop[i]*backdrop[3])):expectedRgb;
    const pixels={stage:pixel(f.stage.x+Math.max(4,f.stage.width/2),3),captionArea:pixel(f.inner[0]-150,3)};
    if(!f.paneHidden)pixels.pane= pixel(f.pane.x+10,3);
    check(f.scroll[0] <= f.inner[0] + 1 && f.scroll[1] <= f.inner[1] + 1, name + ' no page overflow');
    check(Math.abs(f.stage.y) <= 1 && Math.abs(f.stage.height-46) <= 1, name + ' stage titlebar 46px');
    check(f.stageColor===rgbHex(expected.background) && f.railColor===f.stageColor && f.paneColor===f.stageColor, name + ' three titlebar CSS colors match');
    check(lastOverlay.color===expected.background && lastOverlay.symbolColor===expected.symbol && lastOverlay.height===46 && win.getBackgroundColor().toLowerCase()===expected.background, name + ' actual native overlay/background match');
    check(pixels.stage.every((v,i)=>Math.abs(v-composedRgb[i])<=1) && (!pixels.pane || pixels.pane.every((v,i)=>Math.abs(v-composedRgb[i])<=1)), name + ' captured titlebar surface pixels match', {pixels,composedRgb});
    if(f.paneHidden)check(f.captionReserve>=138, name+' native caption space remains');
    check(f.nav.includes('navAppearance') && f.nav.includes('navHome') && f.nav.includes('navPlanner') && f.nav.includes('navExtensions') && f.nav.includes('navGlobalMore'),name+' navigation entries remain');
    const file=name+'.png';fs.writeFileSync(path.join(OUT,file),nativeImage.toPNG());screenshots.push(file);
    facts.push({name,...context,...f,zoom:win.webContents.getZoomFactor(),nativeBounds:win.getContentBounds(),imageSize,pixels,appliedNativeOverlay:{...lastOverlay},controllerTheme:theme.snapshot()});
    console.log('SCENE '+name);
  }
  async function installEarlyFrames() {
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{window.__ui1FirstFrames=[];let ticks=0;const take=()=>{const head=document.querySelector('.stage-head');if(head&&getComputedStyle(document.documentElement).getPropertyValue('--ui-titlebar').trim()){window.__ui1FirstFrames.push({theme:document.documentElement.dataset.theme,preference:document.documentElement.dataset.themePreference,color:getComputedStyle(head).backgroundColor,time:performance.now()});if(window.__ui1FirstFrames.length>=3)return;}if(++ticks<300)requestAnimationFrame(take);};requestAnimationFrame(take);})()`});
  }
  async function captureNativeWindow(mode) {
    // Enumerate window sources, but save only the exact current fixture window.
    // capturePage excludes native caption controls and is not substituted here.
    try {
      const mediaSourceId=win.getMediaSourceId();
      const scaleFactor=screen.getDisplayMatching(win.getBounds()).scaleFactor;
      const [width,height]=win.getSize();
      const sources=await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:Math.round(width*scaleFactor),height:Math.round(height*scaleFactor)},fetchWindowIcons:false});
      const own=sources.find(source=>source.id===mediaSourceId);
      const file=`${mode}-native-window-caption.png`;
      let thumbnail=own?.thumbnail, method='desktopCapturer exact source';
      if((!thumbnail||thumbnail.isEmpty())&&process.platform==='win32') {
        // PrintWindow targets only the HWND returned by this fixture BrowserWindow.
        // Never capture the desktop, foreground window or any other process.
        const hwnd=win.getNativeWindowHandle().readBigUInt64LE().toString();
        const destination=path.join(OUT,file).replaceAll("'","''");
        const script=`Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class FixtureWindowCapture {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd,IntPtr dc,uint flags);
}
'@
[void][FixtureWindowCapture]::SetProcessDpiAwarenessContext([IntPtr](-4))
$rect=New-Object FixtureWindowCapture+RECT
if(-not [FixtureWindowCapture]::GetWindowRect([IntPtr]${hwnd},[ref]$rect)){throw 'fixture rect unavailable'}
$bitmap=New-Object System.Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))
$graphics=[System.Drawing.Graphics]::FromImage($bitmap); $dc=$graphics.GetHdc()
try {if(-not [FixtureWindowCapture]::PrintWindow([IntPtr]${hwnd},$dc,2)){throw 'fixture PrintWindow unavailable'}} finally {$graphics.ReleaseHdc($dc);$graphics.Dispose()}
try {$bitmap.Save('${destination}',[System.Drawing.Imaging.ImageFormat]::Png)} finally {$bitmap.Dispose()}`;
        await new Promise((resolve,reject)=>{
          const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:'ignore'});
          const timer=setTimeout(()=>{child.kill();reject(new Error('owned window capture timeout'));},15000);
          child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('owned window capture failed'))});
        });
        thumbnail=require('electron').nativeImage.createFromPath(path.join(OUT,file));method='Win32 PrintWindow exact fixture HWND';
      }
      if(!thumbnail||thumbnail.isEmpty()){nativeWindowSnapshots.push({mode,available:false,reason:'exact fixture window thumbnail unavailable'});return;}
      const pixels=thumbnail.toBitmap(), colors=new Set();
      for(let offset=0;offset<pixels.length&&colors.size<16;offset+=4)colors.add(pixels[offset]+','+pixels[offset+1]+','+pixels[offset+2]);
      if(colors.size<16){nativeWindowSnapshots.push({mode,available:false,reason:'OS capture returned a blank/uniform image; not visual evidence',diagnosticFile:file,method});return;}
      fs.writeFileSync(path.join(OUT,file),thumbnail.toPNG());screenshots.push(file);
      nativeWindowSnapshots.push({mode,available:true,file,method,sourceMatchedExactly:true,scaleFactor,windowSize:[width,height],imageSize:thumbnail.getSize()});
      console.log('NATIVE WINDOW '+file);
    } catch(error) {nativeWindowSnapshots.push({mode,available:false,reason:error.name||'capture unavailable'});}
  }
  async function makeWindow() {
    console.log('START create themed window');
    theme=createDesktopTheme({ipcMain,nativeTheme,getWindow:()=>win,origin,preferenceFile});theme.register();
    const options=theme.windowOptions();lastOverlay={...options.titleBarOverlay};overlayCalls.push({initial:true,...lastOverlay});
    win=new BrowserWindow({width:1536,height:900,useContentSize:true,show:false,titleBarStyle:'hidden',...options,autoHideMenuBar:true,webPreferences:{preload:path.join(ROOT,'electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,additionalArguments:['--pi-gui-theme-bridge']}});
    const actualSetOverlay=win.setTitleBarOverlay.bind(win);
    win.setTitleBarOverlay=options=>{actualSetOverlay(options);lastOverlay={...options};overlayCalls.push({...options});};
    win.webContents.on('console-message',(_event,level,message)=>{if(level>=3&&!message.includes('Electron Security Warning'))consoleErrors.push(message);});
    win.webContents.on('render-process-gone',(_event,details)=>consoleErrors.push('render-process-gone:'+details.reason));
    if(!controller){controller=createBrowserController({origin,getWindow:()=>win,ipcMain});controller.register();}
    if(!agent){agent=createBrowserAgentHost({browser:controller,origin,getWindow:()=>win,ipcMain,extensionPath:path.join(ROOT,'extensions/pi-gui-browser/index.js')});await agent.start();}
    console.log('START native Browser controller ready');
    // A document must exist before sending Page-domain instrumentation commands.
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');await installEarlyFrames();
    console.log('START early frame instrumentation ready');
    await Promise.race([win.loadURL(origin),sleep(15000).then(()=>{throw new Error('Window loadURL timeout');})]);win.show();
    console.log('START fixture page loaded');
    await waitFor(`document.querySelector('#connText').textContent==='已连接'&&!!document.querySelector('#stream .msg')`,'initial fixture');
    await waitFor(`window.__ui1FirstFrames?.length>=1`,'first shell frame').catch(async error=>{console.error('Frame diagnostics',await read(`({frames:window.__ui1FirstFrames,head:!!document.querySelector('.stage-head'),token:getComputedStyle(document.documentElement).getPropertyValue('--ui-titlebar'),visibility:document.visibilityState})`));throw error;});
  }
  async function disposeWindow(final = false) {
    if(final){await agent?.stop?.();agent=null;}
    controller?.destroy?.();theme?.dispose();theme=null;
    if(win&&!win.isDestroyed())win.destroy();win=null;await sleep(120);
  }
  async function main() {
    fs.mkdirSync(OUT,{recursive:true});console.log('START awaiting Electron readiness');await app.whenReady();console.log('START Electron ready');
    harness=spawn(process.execPath,[path.join(ROOT,'tests/visual-harness.cjs')],{cwd:process.env.UI1_THEME_WORLD,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',HARNESS_PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});
    harness.stderr.on('data',chunk=>consoleErrors.push('harness:'+chunk.toString()));
    origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Harness startup timeout')),15000);harness.stdout.on('data',chunk=>{const m=chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});harness.once('error',reject);});
    console.log('START offline harness ready');
    fixture=require('node:http').createServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><title>Theme local preview</title><style>body{font:16px system-ui;padding:24px;margin:0;background:#fff;color:#222}</style><h1>Local fixture / 本地预览</h1><p>This white document has its own content theme.</p>');});
    await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
    await makeWindow();check(theme.snapshot().preference==='dark','fresh desktop preference defaults dark');
    check(await read(`!!window.piGuiDesktop?.theme&&!!window.piGuiDesktop?.browser`),'actual gated preload exposes named theme and Browser bridges');
    await shot('initial-dark');
    for(const mode of ['dark','light']) {
      await selectTheme(mode);
      win.setContentSize(1200,900);await sleep(180);await captureNativeWindow(mode);
      for(const width of [700,900,1200,1536]) {
        win.setContentSize(width,width===700?600:900);await sleep(180);
        for(const sidebar of [true,false]) {
          await setSidebar(sidebar);
          for(const surface of ['closed','changes','browser']) {await pane(surface);await shot(`${mode}-${width}-sidebar-${sidebar?'open':'closed'}-${surface}`,{matrix:'theme-width-sidebar-pane',requestedWidth:width,sidebar,surface});}
        }
      }
      await closePane();await setSidebar(true);win.setContentSize(1200,900);
      await openAppearance();
      await key('Tab','Tab',9);check(await read(`document.activeElement.matches('#modalCard .modal-actions button')`),mode+' Tab moves select to Close');
      await key('Tab','Tab',9);check(await read(`document.activeElement.matches('.appearance-body select')`),mode+' Tab wraps to select');
      await key('Tab','Tab',9,8);check(await read(`document.activeElement.matches('#modalCard .modal-actions button')`),mode+' Shift+Tab wraps to Close');
      await shot(mode+'-appearance-keyboard');await key('Escape','Escape',27);
      check(await read(`document.querySelector('#modal').hidden&&document.activeElement.id==='navGlobalMore'`),mode+' Escape returns focus');
      for(const zoom of [.8,1.25,1.5]) {
        win.webContents.setZoomFactor(zoom);await sleep(180);await pane('changes');
        await shot(`${mode}-zoom-${zoom}-changes`,{matrix:'additional-zoom',nativeWidth:1200});await closePane();
      }
      win.webContents.setZoomFactor(1);await sleep(180);
    }
    await selectTheme('system');
    for(const simulated of ['dark','light']) {
      const before=theme.snapshot().revision;nativeTheme.themeSource=simulated;nativeTheme.emit('updated');
      await waitFor(`document.documentElement.dataset.theme===${JSON.stringify(simulated)}`,'application-nativeTheme simulation');
      check(theme.snapshot().preference==='system'&&theme.snapshot().revision>before,'system event propagates without changing preference '+simulated);
      await shot('system-app-simulated-'+simulated,{simulation:'nativeTheme.themeSource in this app only; no OS setting change'});
    }
    await selectTheme('light');await closePane();await setSidebar(true);
    win.webContents.reload();await waitFor(`document.querySelector('#connText').textContent==='已连接'&&window.__ui1FirstFrames?.length`,'reload');
    const reloadFrames=await read(`window.__ui1FirstFrames`);frameSamples.push({kind:'reload',frames:reloadFrames});
    check(reloadFrames.every(f=>f.theme==='light'&&f.color===rgbHex(THEME_PALETTE.light.background)),'reload earliest available shell frames remain light',reloadFrames);
    await shot('light-reload-first-shell');
    await disposeWindow();await makeWindow();
    const recreateFrames=await read(`window.__ui1FirstFrames`);frameSamples.push({kind:'window-recreate',frames:recreateFrames});
    check(theme.snapshot().preference==='light'&&recreateFrames.every(f=>f.theme==='light'&&f.color===rgbHex(THEME_PALETTE.light.background)),'recreated controller/window restores persisted light before visible shell',recreateFrames);
    await shot('light-recreated-window');
    win.maximize();await sleep(350);check(win.isMaximized(),'native maximize');await shot('light-maximized');
    win.unmaximize();await sleep(350);check(!win.isMaximized(),'native unmaximize');await shot('light-unmaximized');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    check(await read(`matchMedia('(prefers-reduced-motion:reduce)').matches&&getComputedStyle(document.querySelector('.icon-btn')).transitionDuration.split(',').every(x=>parseFloat(x)===0)`),'reduced motion removes actual icon-button transitions');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
    check(consoleErrors.length===0,'no renderer/harness console errors',consoleErrors);
  }
  main().catch(error=>{errors.push(error.stack||String(error));console.error(error);exitCode=1;}).finally(async()=>{
    clearTimeout(watchdog);
    if(errors.length)exitCode=1;
    const report={passed:checks.filter(x=>x.pass).length,failed:checks.filter(x=>!x.pass).length,checks,errors,consoleErrors,screenshots,facts,frameSamples,overlayCalls,nativeWindowSnapshots,durationMs:Date.now()-started,coverage:{matrix:'light/dark × widths 700/900/1200/1536 × sidebar open/closed × pane closed/Changes/Browser at zoom 1',additional:'both themes at zoom .8/1.25/1.5; appearance keyboard; app-local nativeTheme events; reload/recreate first shell frame; maximize/unmaximize; reduced motion; exact native window thumbnails where supported',limits:'offline visual harness, actual Electron/controller/preload; system events simulated within app, not OS theme or OS DPI validation; earliest available shell rAF is not compositor first-paint proof; capturePage pixels cover web surfaces only, native caption thumbnails reported separately'},versions:{electron:process.versions.electron,chrome:process.versions.chrome},fixture:'temporary os.tmpdir userData and port-0 offline harness; no real Pi/model/session writes'};
    fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify(report,null,2));
    console.log(`Theme Electron ${report.passed}/${checks.length}; failed ${report.failed}; errors ${errors.length}; screenshots ${screenshots.length}`);
    await disposeWindow(true).catch(()=>{});fixture?.close();harness?.kill();await sleep(200);app.exit(exitCode);
  });
}
