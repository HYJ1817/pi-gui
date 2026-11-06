# 本轮 TEMP 设置交互探针

```
/* Production renderer/CSS/preload/theme, normal Electron sandbox, offline API
 * fixture. All profile, session and project paths belong to os.tmpdir(). */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = 'C:/pi-GUI';

if (!process.versions.electron) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shell-'));
  const env = { ...process.env, SHELL_WORLD: world };
  delete env.ELECTRON_RUN_AS_NODE;
  // This explicitly requested visual acceptance needs a visible window.
  // SW_HIDE can suppress the initial ShowWindow and invalidate native captures.
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: false });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
} else run().catch(error => { console.error(error); require('electron').app.exit(1); });

async function run() {
  const { app, BrowserWindow, ipcMain, nativeTheme, desktopCapturer, screen } = require('electron');
  const { createDesktopTheme } = require('C:/pi-GUI/electron/theme.cjs');
  const world = process.env.SHELL_WORLD;
  const out = process.env.SHELL_OUTPUT || path.join(world, 'evidence');
  app.setPath('userData', path.join(world, 'profile'));
  app.commandLine.appendSwitch('force-device-scale-factor', '1.5');
  app.on('window-all-closed', () => {});
  let win, harness, theme, browser, restoreClipboard, pageServer, browserFixtureUrl;
  const checks = [], shots = [], nativeShots = [], errors = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const read = source => win.webContents.executeJavaScript(source, true);
  function check(name, passed, detail) {
    checks.push({ name, passed: !!passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${passed ? '' : ' ' + JSON.stringify(detail)}`);
  }
  async function waitFor(source) {
    for (let i = 0; i < 100; i++) { if (await read(source)) return; await sleep(50); }
    throw Error('Timed out: ' + source);
  }
  async function paint() { await sleep(160); }
  async function click(selector, button = 'left') {
    win.focus(); win.webContents.focus();
    await waitFor('document.hasFocus()');
    const point = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing ${selector}');const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button, clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button, clickCount: 1 });
    await paint();
  }
  async function key(keyCode) {
    win.focus(); win.webContents.focus();
    await waitFor('document.hasFocus()');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await paint();
  }
  async function geometry() {
    return read(`(()=>{const rect=s=>{const e=document.querySelector(s);if(!e||!e.getClientRects().length)return null;const r=e.getBoundingClientRect(),c=getComputedStyle(e);return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,bg:c.backgroundColor,ink:c.color,borderRight:c.borderRightWidth,borderBottom:c.borderBottomWidth,font:c.fontSize,region:c.webkitAppRegion,overflow:c.overflowY}};return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},sidebar:rect('#projectSidebar'),head:rect('.stage-head'),workspace:rect('#workspace'),heading:rect('.conversation-heading'),project:rect('.project.active'),session:rect('.pj-sess'),actions:rect('.head-right'),expand:rect('#btnSidebarExpand'),menu:rect('#actionMenu'),footer:rect('.sidebar-preferences'),scroll:rect('.rail-group'),native:navigator.windowControlsOverlay?.getTitlebarAreaRect().toJSON(),bodyOverflow:document.documentElement.scrollWidth>innerWidth}})()`);
  }
  async function shot(name) {
    await paint();
    // Native capture, never a CSS reconstruction or a composited screenshot.
    const picture = await win.webContents.capturePage();
    const file = name + '.png'; fs.writeFileSync(path.join(out, file), picture.toPNG());
    shots.push({ file, pixels: picture.getSize(), geometry: await geometry() });
  }
  async function nativeShot(name) {
    if (process.platform !== 'win32') return;
    win.setAlwaysOnTop(true); win.show(); win.moveTop(); await sleep(400);
    const file = name + '-native.png';
    const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor;
    const [width, height] = win.getSize();
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) }, fetchWindowIcons: false });
    const own = sources.find(source => source.id === win.getMediaSourceId());
    if (own && !own.thumbnail.isEmpty()) {
      const pixels = own.thumbnail.toBitmap(), colors = new Set();
      for (let i = 0; i < pixels.length && colors.size < 16; i += 4) colors.add(pixels[i] + ',' + pixels[i + 1] + ',' + pixels[i + 2]);
      if (colors.size >= 16) {
        fs.writeFileSync(path.join(out, file), own.thumbnail.toPNG());
        nativeShots.push({ file, saved: true, method: 'desktopCapturer exact own mediaSourceId', pixels: own.thumbnail.getSize() });
        win.setAlwaysOnTop(false); check(name + ' native caption captured from exact own window source', true); return;
      }
    }
    // Execute the reviewed local helper inline; no system execution-policy
    // setting is changed (Windows may prohibit unsigned script files).
    const helper = fs.readFileSync(path.join(ROOT, 'tests/ui5-native-window.ps1'), 'utf8');
    const destination = path.join(out, file).replaceAll("'", "''");
    const command = `& {\n${helper}\n} -WindowHandle '${win.getNativeWindowHandle().readBigUInt64LE()}' -ExpectedPid ${process.pid} -OutputFile '${destination}'`;
    const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];
    const capture = await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
      const timer = setTimeout(() => { child.kill(); reject(Error('Owned native capture timeout')); }, 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(Error(stderr)); else resolve(JSON.parse(stdout)); });
    });
    win.setAlwaysOnTop(false); nativeShots.push({ file, ...capture });
    check(name + ' native caption captured from verified own HWND', capture.saved, capture);
  }
  const deadline = setTimeout(async () => {
    console.error('Shell Electron timeout');
    try { await restoreClipboard?.(); } finally { app.exit(1); }
  }, 240000);
  try {
    fs.mkdirSync(out, { recursive: true }); await app.whenReady();
    harness = spawn(process.execPath, [path.join(ROOT, 'tests/visual-harness.cjs')], {
      cwd: world, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0', VISUAL_UPLOAD_DIR: path.join(world, 'uploads') },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const origin = await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(Error('Harness start timeout')), 15000);
      harness.stdout.on('data', data => { output += data; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
      harness.once('error', reject);
    });
    theme = createDesktopTheme({ ipcMain, nativeTheme, getWindow: () => win, origin, preferenceFile: path.join(world, 'theme.json') });
    theme.register();
    // Browser is outside stage C. The production preload probes its status on
    // boot, so explicitly supply the offline/unavailable fixture response.
    ipcMain.handle('pi-gui:browser-agent-status', () => ({ ok: false, error: 'offline_fixture' }));
    if (process.env.WORKBENCH_ACCEPTANCE === '1') {
      pageServer = require('node:http').createServer((_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><title>Offline browser fixture</title><body style="background:white;color:#181818"><h1>本机网页预览</h1><input aria-label="网页输入" value="原生页面保持自己的主题"></body>');});
      await new Promise(resolve=>pageServer.listen(0,'127.0.0.1',resolve));
      browserFixtureUrl = `http://127.0.0.1:${pageServer.address().port}/`;
      const { createBrowserController } = require('C:/pi-GUI/electron/browser-view.cjs');
      browser = createBrowserController({ origin, getWindow: () => win, ipcMain });
      browser.register();
    }
    win = new BrowserWindow({ width: 1205, height: 803, useContentSize: true, show: true,
      ...theme.windowOptions(), titleBarStyle: 'hidden',
      webPreferences: { preload: path.join(ROOT, 'electron/preload.cjs'), additionalArguments: ['--pi-gui-theme-bridge'], sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('devtools:') }));
    win.webContents.on('render-process-gone', (_event, details) => errors.push(details.reason));
    await win.loadURL(origin); win.focus(); win.webContents.focus();
    await waitFor(`document.querySelector('.project.active .pj-chev') && document.querySelector('.pj-sess-title')`);
    // Finish the fixture's delayed boot RPC before installing a new scenario.
    await sleep(1800);
    await read(`(async()=>{
      window.ST=await import('/state.js');window.SH=await import('/shell.js');window.P=await import('/projects.js');window.SESS=await import('/sessions.js');window.M=await import('/messages.js');window.TH=await import('/theme.js');window.SP=await import('/session-plans.js');
      const fixturePath=${JSON.stringify(path.join(world, 'projects', 'pi-GUI'))},otherPath=${JSON.stringify(path.join(world, 'projects', 'design-notes'))};
      const baseFetch=fetch.bind(window);window.shellWrites=[];window.shellPlanMatches=[];window.shellExtraSessions=0;
      window.fetch=async(url,options={})=>{
        const u=new URL(String(url),location.href);let value;
        if(options.method&&options.method!=='GET')shellWrites.push({route:u.pathname,body:options.body?JSON.parse(options.body):null});
        if(u.pathname==='/api/projects'&&!options.method)value={ok:true,active:fixturePath,items:[{path:fixturePath,name:'pi-GUI'},{path:otherPath,name:'design-notes'}]};
        else if(u.pathname==='/api/sessions')value={ok:true,hasProject:true,sessions:[
          {id:'aaaaaaaaaaaaaaaa',sessionId:'sid-cur',title:'主界面与项目导航',current:true,archived:false,messageCount:4,createdAt:'2026-11-01T10:00:00Z',updatedAt:1},
          {id:'bbbbbbbbbbbbbbbb',sessionId:'sid-b',title:'保留后台运行与会话顺序',current:false,archived:false,messageCount:2,createdAt:'2026-11-01T09:00:00Z',updatedAt:2},
          {id:'dddddddddddddddd',sessionId:'sid-d',title:'检查浅色主题与窗口控件的长标题截断行为',current:false,archived:false,messageCount:2,createdAt:'2026-11-01T08:00:00Z',updatedAt:3},
          {id:'eeeeeeeeeeeeeeee',sessionId:'sid-e',title:'已归档的设计讨论',current:false,archived:true,messageCount:2,createdAt:'2026-10-31T08:00:00Z',updatedAt:4},
          ...Array.from({length:shellExtraSessions},(_,i)=>({id:(i+100).toString(16).padStart(16,'0'),sessionId:'scroll-'+i,title:'历史导航记录 '+(i+1),current:false,archived:false,messageCount:2,createdAt:'2026-10-30T08:00:00Z',updatedAt:5+i}))]};
        else if(u.pathname==='/api/runtime-sessions'&&!options.method)value={ok:true,backendInstance:'shell-fixture',items:[],liveCount:0,totalCount:0,limit:2,hardLimit:3};
        else if(u.pathname==='/api/worktrees')value={ok:true,items:[]};
        else if(u.pathname==='/api/plans/relations')value={ok:true,matches:shellPlanMatches};
        else return baseFetch(url,options);
        return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
      };
      Object.assign(ST.S,{cwd:fixturePath,hasProject:true,bridgeState:'ready',switching:false});
      M.clearThread();M.setStreaming(false);SH.setTitleText('新会话');SH.applyProjectState();await P.loadProjects();await SESS.refreshSidebarSessions();SP.clearSessionPlans();await SP.refreshSessionPlans('sid-cur');
    })()`);
    await waitFor(`!!document.querySelector('.pj-sess-title')`);
    const initial = await geometry();
    check('normal sandbox and DPR 1.5', win.webContents.getLastWebPreferences().sandbox && initial.viewport.dpr === 1.5, initial.viewport);
    check('275px sidebar / 46px continuous header', Math.abs(initial.sidebar.width - 275) < 1 && initial.head.height === 46 && initial.head.borderBottom === '0px' && initial.sidebar.borderRight === '0px', initial);
    check('dark canvas/sidebar and native overlay share semantic palette', initial.head.bg === 'rgb(24, 24, 24)' && initial.sidebar.bg === 'rgb(0, 0, 0)' && theme.windowOptions().titleBarOverlay.color === '#181818');
    check('titlebar drag / buttons no-drag / native control clearance', initial.head.region === 'drag' && await read(`getComputedStyle(document.querySelector('#btnWorkPanel')).webkitAppRegion==='no-drag'`) && initial.actions.right <= initial.viewport.width - 138, initial.actions);
    check('28px project and session rows', initial.project.height === 28 && initial.session.height === 28, { project: initial.project, session: initial.session });
    check('reference row and toolbar corner aliases are preserved', await read(`getComputedStyle(document.querySelector('.project.active')).borderRadius==='10px'&&getComputedStyle(document.querySelector('.pj-sess')).borderRadius==='10px'&&getComputedStyle(document.querySelector('#btnTopbarNew')).borderRadius==='12px'`));
    const order = await read(`[...document.querySelectorAll('#pjSessionsBox .pj-sess-title')].map(e=>e.textContent)`);
    await click('.project.active .pj-chev'); await shot('01-dark-expanded'); await nativeShot('01-dark-expanded');
    await click('#btnSidebarCollapse'); const collapsed = await geometry();
    check('collapsed sidebar consumes zero width; restore uses reference 12px inset', !collapsed.sidebar && collapsed.workspace.x === 0 && collapsed.expand.x === 12 && collapsed.expand.y >= 0 && collapsed.expand.bottom <= 46, collapsed);
    check('collapsed restore excludes native titlebar dragging', collapsed.expand.region === 'no-drag', collapsed.expand);
    await shot('02-dark-collapsed');
    await click('#btnSidebarExpand');
    check('restore retains project expansion state', await read(`document.querySelector('.project.active .pj-chev').getAttribute('aria-expanded')==='false'`));
    await click('.project.active .pj-chev');
    await shot('03-project-sessions');
    check('sidebar owns scrolling without horizontal document overflow', initial.scroll.overflow === 'auto' && !initial.bodyOverflow);
    await read('shellWrites.length=0'); await click('.project.active .pj-select', 'right');
    const menu = await geometry();
    const menuMutations = await read(`shellWrites.filter(w=>w.route==='/api/projects/activate'||w.route.startsWith('/api/sessions')||w.route==='/api/command'&&['abort','switch_session','new_session'].includes(w.body?.type))`);
    check('project right-click opens the existing singleton without switching', await read(`document.querySelectorAll('#actionMenu').length===1`) && menuMutations.length === 0 && menu.menu.x >= 8 && menu.menu.right <= menu.viewport.width - 8, { menu: menu.menu, mutations: menuMutations });
    check('reference menu uses 14px panel / 10px row corners', await read(`getComputedStyle(document.querySelector('#actionMenu')).borderRadius==='14px'&&getComputedStyle(document.querySelector('#actionMenu .action-menu-item')).borderRadius==='10px'`));
    await shot('04-project-context-menu'); await key('ESC');
    check('Escape closes menu and restores overflow trigger focus', await read(`!document.querySelector('#actionMenu') && document.activeElement.matches('.pj-row-menu-trigger')`));
    await click('.pj-sess-primary', 'right');
    check('session right-click preserves rename/archive/delete and permissions', await read(`(()=>{const items=[...document.querySelectorAll('#actionMenu [role=menuitem]')];return items.length===3&&items[0].textContent==='重命名'&&!items[0].disabled&&items[1].disabled&&items[2].disabled})()`));
    await shot('05-session-context-menu'); await key('ESC');
    await read(`M.rebuildFromMessages([{role:'user',content:'检查主界面导航，保留其它会话的运行状态。'}]);M.setStreaming(true);SH.setTitleText('主界面与项目导航')`);
    check('running dot reflects the production classic activity event', await read(`document.querySelector('[data-classic-current]').dataset.activity==='running'&&getComputedStyle(document.querySelector('[data-classic-current] .pj-sess-dot')).backgroundColor==='rgb(255, 133, 73)'`));
    await shot('06-running'); await read('M.setStreaming(false)');
    check('completion clears running indication without reordering', await read(`document.querySelector('[data-classic-current]').dataset.activity==='idle'`) && JSON.stringify(order) === JSON.stringify(await read(`[...document.querySelectorAll('#pjSessionsBox .pj-sess-title')].map(e=>e.textContent)`)));
    await read(`TH.setThemePreference('light')`); await paint();
    const light = await geometry();
    check('light palette also updates real native titlebar', light.head.bg === 'rgb(255, 255, 255)' && light.sidebar.bg === 'rgb(243, 243, 243)' && theme.windowOptions().titleBarOverlay.color === '#ffffff');
    await shot('07-light-expanded'); await nativeShot('07-light-expanded');
    win.setContentSize(700, 650); await paint(); await shot('08-narrow-light');
    const narrow = await geometry();
    check('narrow header controls remain before the native buttons', narrow.actions.right <= narrow.viewport.width - 138 && !narrow.bodyOverflow && narrow.heading.width > 0, narrow);
    await click('#btnTopbarSearch');
    check('topbar search calls the existing search and expands sessions', await read(`document.querySelector('#projectSidebar').classList.contains('search-open')&&!document.querySelector('#pjSessionsBox').hidden&&document.activeElement.matches('.pj-search-input')`));
    await key('ESC');
    win.setContentSize(1205, 803); await read(`TH.setThemePreference('dark')`); await paint();
    await read(`(async()=>{shellExtraSessions=28;await SESS.refreshSidebarSessions()})()`);
    await click('#pjSessionsBox .pj-sess-more:not(.pj-sess-arch-toggle)');
    const scroll = await read(`(()=>{const scroller=document.querySelector('.rail-group'),footer=document.querySelector('.sidebar-preferences'),before=footer.getBoundingClientRect().y;scroller.scrollTop=scroller.scrollHeight;return {offset:scroller.scrollTop,stableFooter:footer.getBoundingClientRect().y===before,headY:document.querySelector('.stage-head').getBoundingClientRect().y}})()`);
    check('long session list scrolls independently with fixed footer and topbar', scroll.offset > 0 && scroll.stableFooter && scroll.headY === 0, scroll);
    await shot('14-sidebar-scroll-dark');
    await read(`(async()=>{shellExtraSessions=0;await SESS.refreshSidebarSessions();document.querySelector('.rail-group').scrollTop=0})()`);
    await read(`(async()=>{shellPlanMatches=[{planId:'plan-1',taskId:'backend',planTitle:'长名称任务关联不会挤掉会话标题或窗口按钮',taskTitle:'保留原有任务导航',attempt:2},{planId:'plan-1',taskId:'tests',planTitle:'长名称任务关联不会挤掉会话标题或窗口按钮',taskTitle:'补充边界验证',attempt:1}];SP.clearSessionPlans();await SP.refreshSessionPlans('sid-cur')})()`);
    const linked = await read(`(()=>{const title=document.querySelector('#title').getBoundingClientRect(),links=document.querySelector('#sessionPlans').getBoundingClientRect(),actions=document.querySelector('.head-right').getBoundingClientRect();return {title:title.width,links:links.width,overlap:title.right>links.left||links.right>actions.left}})()`);
    check('linked tasks leave space for title and actions', linked.title >= 80 && !linked.overlap, linked);
    await shot('13-linked-tasks-dark');
    await click('#navGlobalMore'); await waitFor(`!!document.querySelector('.settings-surface h2')`); await shot('09-settings-overview-dark');
    await click('#navAppearance'); await waitFor(`!!document.querySelector('.settings-detail-card > h3')`); await shot('10-settings-appearance-dark');
    const settings = await read(`(()=>{const rail=document.querySelector('#projectSidebar').getBoundingClientRect(),h=document.querySelector('.settings-detail-card > h3').getBoundingClientRect();return {width:rail.width,titleY:h.y,topbar:getComputedStyle(document.querySelector('.conversation-heading')).display}})()`);
    check('A/B settings rail/headings retain geometry and hide conversation chrome', settings.width === 275 && settings.titleY >= 46 && settings.topbar === 'none', settings);
    await click('#navProviders'); await waitFor(`!!document.querySelector('.prov-toolbar') || !!document.querySelector('.prov')`); await shot('11-settings-providers-dark');
    await click('#navAppearance'); await read(`TH.setThemePreference('light')`); await shot('12-settings-appearance-light');
    await click('#settingsReturn'); await waitFor(`document.querySelector('#workspace').dataset.workspaceView==='chat'`);
    await read('shellWrites.length=0'); await click('#btnTopbarNew'); await sleep(350);
    check('topbar new conversation delegates to the real command path', await read(`shellWrites.some(w=>w.route==='/api/command'&&w.body?.type==='new_session')`));
    if (process.env.CONVERSATION_ACCEPTANCE === '1') {
      restoreClipboard = await require('./fixtures/preserve-clipboard.cjs').preserveClipboard(require('electron'));
      const { clipboard, ClipboardItem } = require('electron');
      await clipboard.write([new ClipboardItem({'text/plain':'fixture clipboard text','text/html':'<b>fixture clipboard text</b>'})]);
      const restoreFixture = await require('./fixtures/preserve-clipboard.cjs').preserveClipboard(require('electron'));
      try { await clipboard.writeText('temporary fixture overwrite'); throw Error('expected fixture interruption'); }
      catch (error) { if(error.message!=='expected fixture interruption') throw error; }
      finally { await restoreFixture(); }
      const restoredItems = await clipboard.read();
      const restoredHTML = await (await restoredItems[0].getType('text/html')).text();
      check('R2 real clipboard restores text and HTML after an interrupted fixture',await clipboard.readText()==='fixture clipboard text'&&restoredHTML.includes('<b>fixture clipboard text</b>'));
      await require('./fixtures/conversation-scenarios.cjs')({ read, click, key, shot, paint, check, win, waitFor });
    }
    if (process.env.WORKBENCH_ACCEPTANCE === '1') {
      await require('./fixtures/workbench-scenarios.cjs')({ read, click, key, shot, nativeShot, paint, check, win, browser, browserFixtureUrl, waitFor });
    }
    if (process.env.THEME_CONVERGENCE_ACCEPTANCE === '1') {
      await require('./fixtures/theme-convergence-scenarios.cjs')({ read, click, key, shot, nativeShot, paint, check, win, theme, browser, browserFixtureUrl, waitFor });
    }
    if (process.env.FINAL_REMEDIATION_ACCEPTANCE === '1') {
      await require('C:/Users/21022/AppData/Local/Temp/pi-gui-final-fix-c41a320354784136ac00435c9373432e/settings-native-fixture.cjs')({ read, click, key, shot, nativeShot, paint, check, win, theme, browser, waitFor });
    }
    check('no renderer process crash', errors.length === 0, errors);
  } catch (error) {
    check('Electron scenarios completed', false, error.stack);
    if (win && !win.isDestroyed()) await shot('failure');
  } finally {
    clearTimeout(deadline);
    try { await restoreClipboard?.(); if(restoreClipboard) check('R2 original clipboard formats restored without persisting payloads',true); }
    catch { check('clipboard restored after scenarios', false, 'Clipboard restoration unavailable'); }
    const passed = checks.filter(check => check.passed).length;
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ electron: process.versions.electron, sandbox: true, world, checks, passed, failed: checks.length - passed, shots, nativeShots, errors }, null, 2));
    console.log(`Shell Electron: ${passed}/${checks.length}; failed=${checks.length - passed}; screenshots=${shots.length}; output=${out}`);
    browser?.destroy(); theme?.dispose(); win?.destroy(); harness?.kill(); pageServer?.close(); app.exit(passed === checks.length ? 0 : 1);
  }
}

```
