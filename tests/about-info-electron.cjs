/* 「信息」页的真实 Electron 验收：真实渲染进程模块与 CSS，离线 visual-harness
 * 提供诊断 / Pi 更新夹具，桌面能力由受控 preload 提供（临时 userData）。
 * 只在这个一次性夹具里「重启 / 更新」；不触碰用户数据，也不联网。
 * Run: node tests/about-info-electron.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-about-'));
  if (process.platform === 'win32') require('node:child_process').execFileSync('icacls', [world, '/setintegritylevel', '(OI)(CI)L'], { stdio: 'ignore', windowsHide: true });
  const env = { ...process.env, ABOUT_INFO_WORLD: world }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const p = spawn(require('electron'), [__filename, '--no-sandbox'], { env, stdio: 'inherit', windowsHide: true });
  p.on('exit', c => {
    const evidence = path.join(world, 'evidence');
    if (fs.existsSync(evidence) && process.env.ABOUT_INFO_EVIDENCE) fs.cpSync(evidence, path.resolve(process.env.ABOUT_INFO_EVIDENCE), { recursive: true });
    console.log('Evidence: ' + evidence);
    process.exitCode = c || 0;
  });
} else main().catch(e => { console.error(e); require('electron').app.exit(1); });

async function main() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const world = process.env.ABOUT_INFO_WORLD;
  const out = path.join(world, 'evidence');
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(world, 'profile'));
  await app.whenReady();

  const preload = path.join(world, 'preload.cjs');
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('piGuiDesktop',{appUpdate:{state:()=>ipcRenderer.invoke('state'),onState:cb=>{ipcRenderer.on('state',(_e,s)=>cb(s));},download:()=>ipcRenderer.invoke('download'),cancel:()=>ipcRenderer.invoke('cancel'),install:()=>ipcRenderer.invoke('install'),openFolder:()=>Promise.resolve({ok:true})},openExternal:url=>ipcRenderer.invoke('openExternal',url)});`);

  let state = { mode: 'installed', phase: 'idle', currentVersion: '0.15.0' };
  let downloads = 0, installs = 0, external = [];
  ipcMain.handle('state', () => state);
  ipcMain.handle('download', () => { downloads++; return { ok: true }; });
  ipcMain.handle('cancel', () => ({ ok: true }));
  ipcMain.handle('install', () => { installs++; return { ok: true }; });
  ipcMain.handle('openExternal', (_e, url) => { external.push(url); return { ok: true }; });

  const harness = spawn(process.execPath, [path.join(ROOT, 'tests/visual-harness.cjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0', VISUAL_UPLOAD_DIR: path.join(world, 'uploads') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const origin = await new Promise((resolve, reject) => {
    let s = ''; const timer = setTimeout(() => reject(Error('harness timeout')), 20000);
    harness.stdout.on('data', b => { s += b; const m = s.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); resolve(m[0]); } });
  });
  for (let n = 0; n < 80; n++) { try { if ((await fetch(origin + '/api/status')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }

  const win = new BrowserWindow({ width: 1320, height: 820, useContentSize: true, show: true, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
  const checks = []; const errors = [];
  const read = js => win.webContents.executeJavaScript(js, true);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function check(value, name) { checks.push({ name, pass: !!value }); console.log(`${value ? 'PASS' : 'FAIL'} ${name}`); }
  const setState = async next => { state = { ...state, ...next }; win.webContents.send('state', state); await sleep(150); };
  const APP = '[data-about-update="app"]', PI = '[data-about-update="pi"]';
  const openSettings = async () => { await read(`document.querySelector('#navGlobalMore').click()`); await sleep(120); };
  const openInfo = async () => { await openSettings(); await read(`document.querySelector('#navInfo').click()`); await sleep(350); };
  const backToOverview = async () => { await read(`document.querySelector('#settingsReturn')?.click()`); await sleep(200); };
  const clickIn = (scope, label, every = false) => read(`(()=>{const b=[...document.querySelectorAll('${scope} button')].${every ? 'filter' : 'find'}(x=>x.textContent===${JSON.stringify(label)});b?.click();return !!b})()`);
  const shot = async name => { fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  win.webContents.on('console-message', (event, level, message) => {
    const lvl = event && typeof event === 'object' && 'level' in event ? event.level : level;
    const msg = String(event && typeof event === 'object' && 'message' in event ? event.message : message);
    if ((lvl === 'error' || lvl >= 3) && !msg.includes('Electron Security Warning')) errors.push(msg);
  });

  try {
    await win.loadURL(origin); await sleep(700);
    check(await read(`navigator.userAgent.includes('Electron/')`), 'real Electron renderer');
    const bootScript = `(async()=>{try{window.__reqs=[];const original=window.fetch;window.fetch=(url,opts)=>{window.__reqs.push({url:String(url),method:(opts&&opts.method)||'GET'});if(String(url).includes('/api/update')&&(!opts||!opts.method||opts.method==='GET'))return Promise.resolve(new Response(JSON.stringify({ok:true,currentVersion:'0.15.0',latestVersion:'0.16.0',updateAvailable:true,release:{tag:'v0.16.0',notes:'### 改进\\n- 信息页统一版本、更新与重启入口。',url:'https://github.com/HYJ1817/pi-gui/releases/tag/v0.16.0',assets:[{kind:'installer',name:'Pi-GUI-Setup-0.16.0.exe',url:'https://github.com/HYJ1817/pi-gui/releases/download/v0.16.0/Pi-GUI-Setup-0.16.0.exe'},{kind:'portable',name:'Pi-GUI-0.16.0-portable.zip',url:'https://github.com/HYJ1817/pi-gui/releases/download/v0.16.0/Pi-GUI-0.16.0-portable.zip'},{kind:'checksums',name:'SHA256SUMS.txt',url:'https://github.com/HYJ1817/pi-gui/releases/download/v0.16.0/SHA256SUMS.txt'}]}}),{headers:{'content-type':'application/json'}}));return original(url,opts);};window.U=await import('/update.js');window.P=await import('/pi-update.js');U.cancelUpdateAuto();P.cancelPiUpdateAuto();return 'ok';}catch(e){return 'ERR:'+(e&&e.stack||e)}})()`;
    const boot = await read(bootScript);
    check(boot === 'ok', 'update/pi modules loaded with a deterministic fetch fixture: ' + boot);
    check(await read(`!document.querySelector('#navAppUpdates')&&!document.querySelector('#navRestartPi')&&!!document.querySelector('#navInfo')`), 'old update/restart entries are gone, info entry exists');

    await openInfo();
    check(await read(`document.querySelector('.settings-detail h3')?.textContent==='信息'`), 'info page opens from settings');
    check(await read(`(()=>{const h=document.querySelector('.about-hero');return h&&h.querySelector('.about-hero-name').textContent==='pi-GUI'&&h.querySelector('.about-hero-version').textContent==='版本 0.15.0'})()`), 'hero shows the authoritative app version');
    check(await read(`(()=>{const t=document.querySelector('.about-hero-meta').textContent;return t.includes('Pi 0.99.2')&&t.includes('Windows_NT 10.0.26100 x64')&&t.includes('兼容正常')&&t.includes('Pi 运行中')})()`), 'hero shows Pi version, platform, compatibility and runtime');
    check(await read(`(()=>{const h=document.querySelector('.about-hero').getBoundingClientRect();const kids=[...document.querySelector('.about-hero').children].filter(c=>c.getClientRects().length);return kids.length>0&&kids.every(c=>{const r=c.getBoundingClientRect();return Math.abs((r.left+r.right)/2-(h.left+h.right)/2)<=2;})})()`), 'hero content is horizontally centered');
    check(await read(`!document.querySelector('.settings-detail').textContent.includes('开发者工具')&&!document.querySelector('.settings-detail').textContent.includes('DevTools')`), 'no unimplemented developer mode row');
    check(await read(`!!document.querySelector('${APP}')&&!!document.querySelector('${PI}')&&document.querySelector('${APP} .about-update-title').textContent==='软件更新'&&document.querySelector('${PI} .about-update-title').textContent==='Pi 运行时'`), 'two independent update cards');
    check(await read(`document.querySelector('${PI} .update-sec').textContent.includes('Pi 0.99.2')&&document.querySelector('${PI} .update-sec').textContent.includes('新版本 1.0.0 可用')`), 'Pi runtime card checks the independent Pi endpoint');
    check(await read(`document.querySelector('${APP} .update-sec').textContent.includes('Pi GUI v0.15.0')&&!!document.querySelector('${APP} .update-sec')`), 'app card shows the running app version');
    check(await read(`!!document.querySelector('[data-about-action="restart-pi"]')&&document.querySelector('#aboutRestartRow').textContent.includes('重新加载 Pi 配置并重新连接运行时。')`), 'restart row uses the shared wording');
    check(await read(`!!document.querySelector('[data-about-action="open-logs"]')&&!!document.querySelector('[data-about-action="export-report"]')&&!!document.querySelector('[data-about-action="open-diagnostics"]')&&!!document.querySelector('[data-about-action="open-github"]')`), 'log, report, diagnostics and feedback entries exist');

    await shot('about-dark-1320x820');
    check(await read(`(()=>{const p=document.querySelector('${APP}'),s=getComputedStyle(p);return parseFloat(s.borderRadius)>0&&s.backgroundColor!=='rgba(0, 0, 0, 0)'})()`), 'update cards use the shared card surface');
    await read(`document.documentElement.dataset.theme='light';document.documentElement.dataset.themePreference='light'`); await sleep(250);
    check(await read(`getComputedStyle(document.body).backgroundColor!=='rgb(13, 13, 13)'`), 'light theme repaints the info page');
    await shot('about-light-1320x820');
    await read(`document.documentElement.dataset.theme='dark';document.documentElement.dataset.themePreference='dark'`); await sleep(250);

    // pi-GUI 自身更新：检查 → 下载 → 忙碌锁 → 失败 → 就绪
    const checkBtn = await clickIn(`${APP} .update-sec`, '检查更新'); check(checkBtn, 'app update check is clickable');
    await sleep(500);
    check(await read(`document.querySelector('${APP} .update-sec').textContent.includes('v0.16.0')&&document.querySelector('${APP} .update-sec').textContent.includes('下载更新')`), 'app check shows the new version and one download action');
    const download = await clickIn(`${APP} .update-sec`, '下载更新'); check(download, 'app download button is present'); await sleep(300);
    check(downloads === 1, 'download reaches the desktop capability once');
    await setState({ phase: 'downloading', received: 50, total: 100, speed: 10 });
    check(await read(`(()=>{const t=document.querySelector('${APP} .update-sec').textContent;const n=document.querySelectorAll('${APP} .update-sec button.primary').length;return t.includes('50%')&&n===0})()`), 'download busy state shows progress and no duplicate primary action');
    await setState({ phase: 'failed', error: '下载失败，请重试。' });
    check(await read(`document.querySelector('${APP} .update-sec').textContent.includes('下载失败')&&[...document.querySelectorAll('${APP} .update-sec button')].some(b=>b.textContent==='重新下载')`), 'download failure keeps a readable retry');
    await setState({ phase: 'ready', version: '0.16.0', error: '' });
    check(await read(`document.querySelector('${APP} .update-sec').textContent.includes('重启以更新')`), 'ready package exposes restart install');
    await sleep(300); await shot('about-update-ready-dark');

    // Pi 运行时更新：独立确认、取消不发请求、确认后只发一次 POST
    await clickIn(`${PI} .update-sec`, '更新到 1.0.0'); await sleep(250);
    check(await read(`!document.querySelector('#confirmLayer').hidden&&document.querySelector('#ui4ConfirmTitle').textContent.includes('更新 Pi 到 1.0.0')`), 'Pi update opens its own confirmation');
    check(await read(`document.querySelector('#ui4ConfirmMessage').textContent.includes('当前 Pi：0.99.2')&&document.querySelector('#ui4ConfirmMessage').textContent.includes('目标 Pi：1.0.0')&&document.querySelector('#ui4ConfirmMessage').textContent.includes('尚未经过 Pi GUI 的完整兼容验收')`), 'Pi confirmation states current/target and the unverified warning');
    const posts = () => read(`window.__reqs.filter(r=>r.method==='POST'&&r.url.includes('/api/pi-update')).length`);
    check(await posts() === 0, 'opening the Pi confirmation sends no update request');
    await read(`[...document.querySelectorAll('#confirmLayer button')].find(b=>b.textContent==='取消').click()`); await sleep(250);
    check(await read(`document.querySelector('#confirmLayer').hidden`) && await posts() === 0, 'cancelling the Pi update sends no request');
    await clickIn(`${PI} .update-sec`, '更新到 1.0.0'); await sleep(200);
    await read(`[...document.querySelectorAll('#confirmLayer button')].find(b=>b.textContent==='更新').click()`); await sleep(600);
    check(await posts() === 1, 'confirmed Pi update sends exactly one POST');
    check(await read(`document.querySelector('${PI} .update-sec').textContent.includes('Pi 更新没有成功')&&document.querySelector('${PI} .update-sec').textContent.includes('Pi 更新没有开始')`), 'rejected Pi update keeps a readable failure and retry path');
    await shot('about-pi-update-failed-dark');

    // 重启：复用 restartPi 的确认框；取消不发 /api/restart，确认只发一次
    const restarts = () => read(`window.__reqs.filter(r=>r.url.includes('/api/restart')).length`);
    await read(`document.querySelector('[data-about-action="restart-pi"]').scrollIntoView({block:'center'})`); await sleep(150);
    await read(`document.querySelector('[data-about-action="restart-pi"]').click()`); await sleep(250);
    check(await read(`!document.querySelector('#confirmLayer').hidden&&document.querySelector('#ui4ConfirmTitle').textContent.includes('重启 pi')`), 'restart uses the existing confirmation');
    await read(`[...document.querySelectorAll('#confirmLayer button')].find(b=>b.textContent==='取消').click()`); await sleep(250);
    check(await read(`document.querySelector('#confirmLayer').hidden`) && await restarts() === 0, 'cancelled restart sends no /api/restart');
    await read(`document.querySelector('[data-about-action="restart-pi"]').click()`); await sleep(200);
    await read(`[...document.querySelectorAll('#confirmLayer button')].find(b=>b.textContent==='重启 pi').click()`); await sleep(500);
    check(await restarts() === 1, 'confirmed restart sends exactly one /api/restart');
    check(await read(`document.querySelector('[data-about-action="restart-pi"]').disabled===false`), 'restart button is usable again after the action');

    // 日志与故障报告：走既有 logs 页与既有标签
    await read(`document.querySelector('[data-about-action="open-logs"]').click()`); await sleep(500);
    check(await read(`document.querySelector('.settings-detail h3')?.textContent==='日志与故障报告'&&document.querySelector('#ui5-log-tab-overview').getAttribute('aria-selected')==='true'`), 'open logs lands on the existing overview tab');
    await backToOverview(); await openInfo();
    await read(`document.querySelector('[data-about-action="export-report"]').click()`); await sleep(500);
    check(await read(`document.querySelector('#ui5-log-tab-export')?.getAttribute('aria-selected')==='true'`), 'export report lands on the existing export tab');
    await backToOverview(); await openInfo();
    await read(`document.querySelector('[data-about-action="open-diagnostics"]').click()`); await sleep(450);
    check(await read(`document.querySelector('.settings-detail h3')?.textContent==='诊断'&&!document.querySelector('[data-about-update="app"]')`), 'diagnostics quick entry replaces the info page');
    await backToOverview(); await openInfo();
    check(await read(`document.querySelectorAll('${APP} .update-sec').length===1&&document.querySelector('${APP} .update-sec').textContent.includes('重启以更新')`), 'reopening info preserves the ready update state in one container');

    // 外链：只经桥，且是准确的 Issues 地址
    await read(`document.querySelector('[data-about-action="open-github"]').click()`); await sleep(300);
    check(external.length === 1 && external[0] === 'https://github.com/HYJ1817/pi-gui/issues', 'GitHub feedback uses the bridge with the exact issues URL');
    check(await read(`location.href.startsWith(${JSON.stringify(origin)})`), 'feedback does not navigate the app window');

    // 窄窗：真实渲染，无横向溢出，页面可滚动。错误提示按设计常驻，
    // 取证前关掉测试自己触发的那一条，避免遮住页面。
    await read(`[...document.querySelectorAll('#toasts .ui4-feedback-toast-close')].forEach(b=>b.click())`); await sleep(300);
    win.setContentSize(700, 600); await sleep(400);
    check(await read(`(()=>{const d=document.querySelector('.settings-detail');const h=document.querySelector('.about-hero').getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1&&d.scrollWidth<=d.clientWidth+1&&h.right<=innerWidth+1&&d.scrollHeight>=d.clientHeight})()`), '700x600 scrolls without horizontal overflow');
    /* 容器本身必须完整落在视口内：.stage 顶部有 46px 标题栏，滚动容器若被
     * min-height:100% 撑高，最后一行会永远停在裁切区外。 */
    check(await read(`(()=>{const d=document.querySelector('.settings-detail');const last=document.getElementById('aboutFeedbackRow');d.scrollTop=d.scrollHeight;const ok=d.getBoundingClientRect().bottom<=innerHeight+1&&last.getBoundingClientRect().bottom<=innerHeight+1;d.scrollTop=0;return ok})()`), '700x600 can scroll to the last feedback row');
    await shot('about-dark-700x600');
    await read(`document.documentElement.dataset.theme='light';document.documentElement.dataset.themePreference='light'`); await sleep(250);
    await shot('about-light-700x600');
    await read(`document.documentElement.dataset.theme='dark';document.documentElement.dataset.themePreference='dark'`); await sleep(250);
    win.setContentSize(1320, 820); await sleep(200);
    await read(`document.querySelector('[data-about-action="restart-pi"]').scrollIntoView({block:'center'})`); await sleep(150);
    win.webContents.setZoomFactor(1.25); await sleep(300);
    check(await read(`document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.settings-detail').scrollWidth<=document.querySelector('.settings-detail').clientWidth+1`), 'font scaling keeps the page contained');
    await shot('about-font-125-dark');
    win.webContents.setZoomFactor(1);

    check(errors.length === 0, 'renderer has no console errors');
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ checks, errors, external }, null, 2));
  } finally { win.destroy(); harness.kill(); }
  console.log(`about/info Electron: ${checks.filter(c => c.pass).length}/${checks.length}`);
  app.exit(checks.every(c => c.pass) ? 0 : 1);
}
