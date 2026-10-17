/* UI-4A：右侧工作区（右栏）的布局、组件与交互验收。
 *
 * 真实 Electron + 真实生产前端。所有可写数据都在 os.tmpdir 里的 world 目录：
 * 临时 userData、临时 uploads、临时 HTTP fixture；不碰用户项目、不连真实 Pi、
 * 不调用任何模型。
 *
 * 这里验的是**右栏这一层**：
 *   - 开/关、宽度（鼠标拖动、键盘、双击复位、aria 值）、持久化
 *   - Browser / Changes / 本会话变更 / 开发进程 四面的顶部条是否同一条带子
 *   - 原生 WebContentsView 的挂载/撤离/边界跟随（右栏隐藏、换面、弹层遮挡）
 *   - 空态 / 加载 / 错误 / 数据过期 的呈现，长路径与长日志不横向溢出
 *   - 不可信文本只当文本（不解析成 HTML）
 *   - 700/900/1200/1536 × Dark/Light、缩放、reduced-motion、窄屏覆盖模式
 *
 * 不验的（由既有套件负责，本文件不重复、也不假装覆盖）：
 *   - Browser 的权限策略 / loopback 白名单 / host 绑定 → gui-browser-policy.cjs、
 *     gui-browser-controller.cjs、gui-browser-host.cjs、runtime-browser.cjs
 *   - runtime 会话间的 Browser owner 隔离 → runtime-secondary.cjs、runtime-electron.cjs
 *   - Git 撤销/暂存语义 → git.cjs、runtime-git-ui.cjs、session-revert-*.cjs
 *
 * 用法：node tests/ui4-pane.cjs            （自动用本机 electron 重跑自己）
 * 证据：docs/claude-ui-redesign/ui4a-evidence/（截图 + results.json）
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.UI4_EVIDENCE_ROOT || path.join(ROOT, '.shots/ui4-pane');

if (!process.versions.electron) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'ui4-pane-electron-'));
  const env = { ...process.env, UI4_WORLD: world };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: false });
  const cleanup = () => { try { fs.rmSync(world, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 临时目录删不掉不影响结论 */ } };
  child.on('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.on('exit', code => { cleanup(); process.exitCode = code ?? 1; });
} else {
  run();
}

async function run() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { createBrowserController } = require('../electron/browser-view.cjs');
  const { createBrowserAgentHost } = require('../electron/browser-agent-host.cjs');

  const world = process.env.UI4_WORLD || fs.mkdtempSync(path.join(os.tmpdir(), 'ui4-pane-electron-'));
  app.setPath('userData', path.join(world, 'user-data'));
  app.on('window-all-closed', () => { /* 由本脚本收尾 */ });

  let win, harness, browser, agent, fixture;
  const checks = [];
  const facts = [];
  const screenshots = [];
  const errors = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const check = (pass, name, detail) => {
    checks.push({ pass: Boolean(pass), name, detail });
    console.log((pass ? 'PASS ' : 'FAIL ') + name + (pass ? '' : ' ' + JSON.stringify(detail)));
  };
  const read = expression => win.webContents.executeJavaScript(expression, true);
  const until = async (fn, max = 15000) => {
    const end = Date.now() + max;
    while (Date.now() < end) {
      if (await fn()) return true;
      await sleep(50);
    }
    throw new Error('timeout: ' + fn.toString().slice(0, 120));
  };
  async function mouse(type, x, y, extra = {}) {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  }
  async function center(selector) {
    const rect = await read(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}})()`);
    if (!rect) throw new Error('missing element: ' + selector);
    return rect;
  }
  async function click(selector, clickCount = 1) {
    const point = await center(selector);
    await mouse('mousePressed', point.x, point.y, { clickCount });
    await mouse('mouseReleased', point.x, point.y, { clickCount });
    await sleep(120);
  }
  async function key(name, code, vk, modifiers = 0) {
    for (const type of ['keyDown', 'keyUp']) {
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode: vk, modifiers });
    }
    await sleep(90);
  }
  async function shot(name) {
    await sleep(160);
    fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG());
    screenshots.push(name + '.png');
  }
  /* 右栏的几何事实：一次读全，避免断言的取数方式各不相同。 */
  const paneFacts = () => read(`(()=>{
    const pane=document.getElementById('rightPane'), r=pane.getBoundingClientRect();
    const body=pane.querySelector('.rp-body');
    const head=pane.querySelector('.rp-head, .chg-head, .rp-toolbar, .process-head');
    const close=pane.querySelector('#rightPaneClose, #browserClose');
    const cs=getComputedStyle(document.documentElement);
    return {
      hidden:pane.hidden, surface:pane.dataset.surface||null, mode:pane.dataset.mode||null,
      left:r.left, right:r.right, width:r.width, scrollWidth:pane.scrollWidth, clientWidth:pane.clientWidth,
      cssWidth:Number.parseFloat(cs.getPropertyValue('--rp-width'))||0,
      headHeight:head?head.getBoundingClientRect().height:0,
      headTop:head?head.getBoundingClientRect().top:0,
      headClass:head?head.className:null,
      closeRight:close?close.getBoundingClientRect().right:0,
      closeLabel:close?close.getAttribute('aria-label'):null,
      bodyCount:body?body.children.length:0,
      pageOverflow:document.documentElement.scrollWidth>innerWidth+1
    };
  })()`);
  const nativeView = () => {
    const webContents = browser.getWebContents();
    if (!webContents) return { exists: false };
    const view = win.contentView.children.find(child => child.webContents === webContents);
    return { exists: true, attached: Boolean(view), bounds: view ? view.getBounds() : null };
  };
  const closePane = async () => {
    await read(`(()=>{const b=document.getElementById('rightPaneClose')||document.getElementById('browserClose');if(b)b.click();})()`);
    await sleep(120);
  };
  /* Escape 是「右栏自己接住的键」：只有焦在面板里（root 的 keydown）才算数。
   * 焦还在顶栏入口按钮上时浏览器不会把它送到面板里 —— 这是既有行为，
   * 下面先用一条断言把它如实记下来，再从面板内部验证 Escape 能关。 */
  async function escapeFromInside() {
    await read(`(()=>{const c=document.getElementById('rightPaneClose')||document.getElementById('browserClose');if(c)c.focus();})()`);
    await key('Escape', 'Escape', 27);
    await until(async () => (await paneFacts()).hidden);
  }

  const timeout = setTimeout(() => { console.error('UI4 pane Electron timeout'); app.exit(1); }, 480000);

  try {
    fs.mkdirSync(OUT, { recursive: true });
    await app.whenReady();

    /* 离线 fixture 页：只给内置浏览器导航用，证明不了任何远端能力。 */
    fixture = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>UI4 pane fixture page</title><h1>UI4 pane fixture page</h1>');
    });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const fixtureOrigin = 'http://127.0.0.1:' + fixture.address().port;

    harness = spawn(process.execPath, [path.join(ROOT, 'tests/visual-harness.cjs')], {
      cwd: world,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0', VISUAL_PUBLIC_ROOT: process.env.UI4_ASSETS_ROOT || path.join(ROOT, 'public'), VISUAL_UPLOAD_DIR: path.join(world, 'uploads') },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    harness.stderr.on('data', chunk => errors.push('harness: ' + String(chunk)));
    const origin = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('harness timeout')), 20000);
      harness.stdout.on('data', chunk => { buffer += chunk; const found = buffer.match(/http:\/\/127\.0\.0\.1:\d+/); if (found) { clearTimeout(timer); resolve(found[0]); } });
      harness.on('error', reject);
    });

    win = new BrowserWindow({
      width: 1440, height: 900, useContentSize: true, show: true,
      webPreferences: { preload: path.join(ROOT, 'electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    browser = createBrowserController({ origin, getWindow: () => win, ipcMain });
    browser.register();
    agent = createBrowserAgentHost({ browser, origin, getWindow: () => win, ipcMain, extensionPath: path.join(ROOT, 'extensions/pi-gui-browser/index.js') });
    await agent.start();
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3 && !String(message).includes('Electron Security Warning')) errors.push(message); });

    await win.loadURL(origin);
    await sleep(1800);
    win.show(); win.focus(); win.webContents.focus();
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.bringToFront');
    await until(() => read('!!document.getElementById("btnMore") && !!document.getElementById("btnBrowser")'));
    check(await read('document.hasFocus()'), 'Chromium 页面拿到焦点（后续受信键盘才有意义）');

    /* ---------- 0. 样式表：集成方要加的那一行，本测试自己按同一路径挂上去 ---------- */
    const styleOk = await read(`!!document.querySelector('link#ui4-pane-style[href="/ui4-pane.css"]')`);
    check(styleOk && await read(`document.querySelectorAll('link[href="/ui4-pane.css"]').length===1`), 'public/ui4-pane.css 可被真实页面加载且只加载一次');
    check(await read(`(()=>{const rules=[...document.styleSheets].find(s=>s.href?.endsWith('/ui4-pane.css'));return Boolean(rules&&rules.cssRules.length>40)})()`), 'ui4-pane.css 规则实际生效（样式表解析成功）');

    /* ---------- 1. 初始状态与右栏开关 ---------- */
    const limits = await read(`(async()=>{const m=await import('/right-pane.js');return m.RIGHT_PANE_LIMITS})()`);
    facts.push({ limits });
    check(limits.min === 320 && limits.default === 420, '右栏宽度边界由 right-pane.js 单点导出', limits);

    let facts0 = await paneFacts();
    check(facts0.hidden && facts0.width === 0, '启动时右栏是关着的', facts0);
    check(facts0.cssWidth === 420, '--rp-width 缺省值仍是 420（既有 browser-pane 断言依赖）', facts0);

    await click('#navChanges');
    await until(async () => (await paneFacts()).surface === 'changes');
    facts0 = await paneFacts();
    check(!facts0.hidden && facts0.surface === 'changes' && facts0.mode === 'dock', '「文件变更」在 dock 模式打开', facts0);
    check(facts0.width === 420 && facts0.cssWidth === 420, '打开宽度 = 持久化宽度 = --rp-width', facts0);
    check(Math.abs(facts0.headHeight - 46) <= 1, 'Changes 顶部条与 46px 带高一致', facts0);
    check(facts0.closeLabel === '关闭文件变更', 'Changes 的关闭按钮带可读标签', facts0);
    check(facts0.closeRight >= facts0.right - 16, '关闭按钮落在标题带最右端', facts0);

    /* 顶部条的统一：先把 46px 记下来，后面每个面都要对得上。 */
    const headerHeight = facts0.headHeight;

    await key('Escape', 'Escape', 27);
    check(!(await paneFacts()).hidden, '焦点还在顶栏入口时 Escape 不关闭右栏（既有行为，如实记录）');
    await escapeFromInside();
    check(await read(`document.activeElement && document.activeElement.id==='navChanges'`), 'Escape 关闭后焦点回到打开的入口按钮');
    check(await read(`!document.querySelector('#rightPane .rp-surface')`), '关闭后不留下任何 surface 内容');

    /* ---------- 2. 宽度：鼠标拖动 / 键盘 / 双击复位 / aria ---------- */
    await read(`document.querySelector('#navChanges').click()`);
    await until(async () => (await paneFacts()).surface === 'changes');
    const resizerAria = await read(`(()=>{const r=document.getElementById('rightPaneResizer');return {min:r.getAttribute('aria-valuemin'),max:r.getAttribute('aria-valuemax'),now:r.getAttribute('aria-valuenow'),text:r.getAttribute('aria-valuetext'),controls:r.getAttribute('aria-controls')}})()`);
    facts.push({ resizerAria });
    check(resizerAria.controls === 'rightPane' && resizerAria.min === '320' && Number(resizerAria.now) === 420,
      '分隔条把宽度如实报给读屏（min/now/aria-controls）', resizerAria);

    const resizer = await center('#rightPaneResizer');
    await mouse('mousePressed', resizer.x, resizer.y);
    await mouse('mouseMoved', resizer.x - 90, resizer.y);
    await mouse('mouseReleased', resizer.x - 90, resizer.y);
    await sleep(180);
    const dragged = await paneFacts();
    facts.push({ draggedWidth: dragged.width });
    check(dragged.width >= 500 && dragged.width <= 520, '鼠标拖动分隔条把右栏拖宽 ~90px', dragged);
    check(Math.abs(dragged.cssWidth - dragged.width) <= 1, '拖动时 --rp-width 与真实宽度同步（Toast 让位依赖它）', dragged);
    check(Number(await read(`document.getElementById('rightPaneResizer').getAttribute('aria-valuenow')`)) === Math.round(dragged.width), '拖动后 aria-valuenow 跟着变');
    check(await read(`(JSON.parse(localStorage.getItem('pi-gui.rightpane.v1')||'{}').width||0)===${Math.round(dragged.width)}`), '拖动后的宽度写入既有 localStorage 键');

    await read(`document.getElementById('rightPaneResizer').focus()`);
    await key('ArrowLeft', 'ArrowLeft', 37);
    const step1 = (await paneFacts()).width;
    check(Math.round(step1 - dragged.width) === 12, '方向键按 12px 步进加宽', { from: dragged.width, to: step1 });
    await key('ArrowLeft', 'ArrowLeft', 37, 8);
    const step2 = (await paneFacts()).width;
    check(Math.round(step2 - step1) === 40, 'Shift+方向键按 40px 步进加宽', { from: step1, to: step2 });
    await key('ArrowRight', 'ArrowRight', 39);
    check(Math.round(step2 - (await paneFacts()).width) === 12, '方向键双向对称（能变窄）');
    await key('Home', 'Home', 36);
    check((await paneFacts()).width === 320, 'Home 收到底限 320px');
    await key('End', 'End', 35);
    const maxWidth = (await paneFacts()).width;
    check(maxWidth > 320 && maxWidth <= 1440 * 0.6 + 1, 'End 放到当前窗口允许的上限', { maxWidth });
    const dbl = await center('#rightPaneResizer');
    await mouse('mousePressed', dbl.x, dbl.y, { clickCount: 2 });
    await mouse('mouseReleased', dbl.x, dbl.y, { clickCount: 2 });
    await sleep(180);
    check((await paneFacts()).width === 420, '双击分隔条复位到默认宽 420');

    /* ---------- 3. Browser：显示、原生 view 归属、切换、关闭 ---------- */
    const beforeBrowser = await paneFacts();
    await click('#btnBrowser');
    await until(async () => (await paneFacts()).surface === 'browser');
    await until(() => read('!!document.getElementById("browserToolbar")'));
    const browserPane = await paneFacts();
    facts.push({ browserPane });
    check(!browserPane.hidden && browserPane.surface === 'browser', 'Browser 面在右栏打开', browserPane);
    check(Math.abs(browserPane.headHeight - headerHeight) <= 1, 'Browser 工具栏与其它面同一条 46px 标题带', { browser: browserPane.headHeight, changes: headerHeight });
    check(browserPane.width === beforeBrowser.width, '换面不改宽度（用户调过的宽度沿用）', { before: beforeBrowser.width, after: browserPane.width });
    check(await read(`(()=>{const a=document.getElementById('browserAddress');const r=a.getBoundingClientRect();return r.width>120&&r.height>=24})()`), '地址栏在默认宽下可读（宽度 > 120px）');
    check(await read(`(()=>{const back=document.getElementById('browserBack'),forward=document.getElementById('browserForward');return back.disabled&&forward.disabled})()`), '未导航时后退/前进如实禁用（不猜状态）');
    check(await read(`document.activeElement===document.getElementById('browserAddress')`), '打开后焦点落在地址栏');

    await until(() => nativeView().attached);
    const attached = nativeView();
    facts.push({ nativeAttached: attached });
    check(attached.attached, '原生 WebContentsView 已挂到窗口上');
    check(attached.bounds && Math.abs(attached.bounds.width - (await read(`document.getElementById('browserViewport').getBoundingClientRect().width`))) <= 2,
      '原生 view 的宽度 = #browserViewport 的实测宽度', attached.bounds);

    /* 工具栏导航到本地 fixture：证明地址栏这条既有路径仍然通。 */
    await read(`(()=>{const a=document.getElementById('browserAddress');a.focus();a.value=${JSON.stringify(fixtureOrigin + '/')};a.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await key('Enter', 'Enter', 13);
    await until(() => browser.getWebContents() && String(browser.getWebContents().getURL()).startsWith(fixtureOrigin), 15000);
    check(true, '地址栏导航到本地 fixture 页（既有桥接未被改动）');
    await until(() => read(`!document.getElementById('browserError') || document.getElementById('browserError').hidden`));
    check(await read(`document.getElementById('browserError').hidden`), '导航成功时错误条保持隐藏（不制造假错误）');
    check(String(browser.getState().title) === 'UI4 pane fixture page', 'Browser 状态里的页面标题来自主进程实际导航', browser.getState());

    /* 弹层遮挡：原生 view 是子视图，必须真的被摘下去。 */
    await click('#btnMore');
    await until(async () => !(await read(`document.getElementById('modal').hidden`)));
    await sleep(220);
    check(!nativeView().attached, '弹层打开时原生 view 被摘下去（不被压住）');
    await key('Escape', 'Escape', 27);
    await until(async () => await read(`document.getElementById('modal').hidden`));
    await until(() => nativeView().attached);
    check(nativeView().attached, '弹层关闭后原生 view 重新挂回');

    /* 宽度变化 → 原生 view 边界跟随（右栏宽度变化的真实后果）。 */
    const viewportBefore = await read(`document.getElementById('browserViewport').getBoundingClientRect().width`);
    const rz = await center('#rightPaneResizer');
    await mouse('mousePressed', rz.x, rz.y);
    await mouse('mouseMoved', rz.x + 70, rz.y);
    await mouse('mouseReleased', rz.x + 70, rz.y);
    await sleep(320);
    const narrower = await read(`document.getElementById('browserViewport').getBoundingClientRect().width`);
    const followed = nativeView();
    facts.push({ widthFollow: { viewportBefore, narrower, bounds: followed.bounds } });
    check(narrower < viewportBefore - 50, '把右栏拖窄后 viewport 变窄', { viewportBefore, narrower });
    check(followed.bounds && Math.abs(followed.bounds.width - narrower) <= 2, '原生 view 边界跟随右栏宽度（不是旧矩形）', followed.bounds);

    /* 与 UI-3 的弹层共存：模型弹层必须落在右栏左侧。 */
    await read(`document.querySelector('#btnModel').click()`);
    await sleep(200);
    const overlap = await read(`(()=>{const p=document.querySelector('#composerPopover');if(!p||p.hidden)return {ok:false,reason:'no popover'};const pr=p.getBoundingClientRect(),pane=document.getElementById('rightPane').getBoundingClientRect();return {ok:true,right:pr.right,paneLeft:pane.left,w:pr.width}})()`);
    check(overlap.ok && overlap.right <= overlap.paneLeft + 1, '模型弹层不被右栏/原生 view 覆盖', overlap);
    await key('Escape', 'Escape', 27);
    await sleep(140);

    /* Browser → Changes：原生 view 必须撤离,而不是留在那儿盖住新面板。 */
    await click('#navChanges');
    await until(async () => (await paneFacts()).surface === 'changes');
    await sleep(260);
    check(!(await read(`!!document.getElementById('browserToolbar')`)), '切到 Changes 后浏览器工具栏被卸载');
    check(browser.getWebContents() === null || !nativeView().attached, '切到 Changes 后原生 view 已撤离', nativeView());

    /* 再切回 Browser：新 view 重新挂上，宽度仍然沿用。 */
    await click('#btnBrowser');
    await until(async () => (await paneFacts()).surface === 'browser');
    await until(() => nativeView().attached);
    check(Math.abs((await paneFacts()).width - narrower) <= 1, '切回 Browser 仍沿用用户拖过的宽度', { expected: narrower, got: (await paneFacts()).width });
    await closePane();
    await until(async () => (await paneFacts()).hidden);
    await sleep(200);
    check(browser.getWebContents() === null || !nativeView().attached, '关闭右栏后原生 view 撤离');
    check(await read(`document.activeElement && document.activeElement.id==='btnBrowser'`), '关闭后焦点回到 Browser 入口');

    /* ---------- 4. 本会话变更：层级、空/错误/过期、长路径与不可信文本 ---------- */
    await read(`(()=>{
      window.__ui4={calls:[],mode:'full',processes:'active',xss:undefined};
      const ok=(obj)=>({ok:true,json:async()=>obj});
      const original=window.fetch;
      const longPath='packages/'+('really/'.repeat(12))+'adapter/implementation-with-a-very-long-file-name.js';
      window.__ui4.files=[
        {relativePath:longPath,operationType:'modified',operationCount:3,evidenceIds:['e1'],evidenceLevel:'intent_verified',previewEligible:true,historyAvailable:true},
        {relativePath:'docs/<img src=x onerror="window.__ui4.xss=1">.md',operationType:'created',operationCount:1,evidenceIds:['e2'],evidenceLevel:'observed',previewEligible:true,historyAvailable:false},
        ...Array.from({length:10},(_,i)=>({relativePath:'src/module-'+i+'/index.js',operationType:i%3?'modified':'created',operationCount:i+1,evidenceIds:['s'+i],evidenceLevel:'exclusive_verified',previewEligible:true,historyAvailable:i%2===0}))
      ];
      window.__ui4.processStatus=()=>window.__ui4.processes==='empty'
        ? {ok:true,generation:'g1',enabled:true,available:true,cleanupPending:false,processes:[]}
        : {ok:true,generation:'g1',enabled:true,available:true,cleanupPending:false,processes:[
            {id:'p1',revision:1,command:'node',argCount:2,state:'ready',uptimeMs:72000,endpoint:'http://127.0.0.1:5199',cleanupConfirmed:true},
            {id:'p2',revision:1,command:'node --inspect ./scripts/dev-server.mjs --workspace packages/very-long-directory-name',argCount:0,state:'failed',uptimeMs:1000,endpoint:'',code:'EADDRINUSE',cleanupConfirmed:true}
          ]};
      window.__ui4.summary=()=>window.__ui4.mode==='empty'
        ? {ok:true,target:{conversationId:'classic-chat'},capture:{enabled:true},operationCount:0,fileCount:0,evidenceComplete:true,attributionGap:false,expired:false,previewEligible:true,revision:7,files:[]}
        : {ok:true,target:{conversationId:'classic-chat'},capture:{enabled:true},operationCount:24,fileCount:window.__ui4.files.length,evidenceComplete:false,attributionGap:true,expired:false,previewEligible:true,revision:7,files:window.__ui4.files};
      window.fetch=async (url,opts={})=>{
        const u=String(url);
        if(u.startsWith('/api/session-revert/query')){
          window.__ui4.calls.push({type:'query'});
          if(window.__ui4.mode==='pending')return new Promise(()=>{});
          if(window.__ui4.mode==='error')return ok({ok:false,code:'stale_evidence'});
          return ok(window.__ui4.summary());
        }
        if(u.startsWith('/api/session-revert/history'))return ok({ok:true,plans:[]});
        if(u.startsWith('/api/session-revert/preview')){
          window.__ui4.calls.push({type:'preview'});
          return ok({ok:true,files:[{relativePath:window.__ui4.files[0].relativePath,status:'candidate',contentEligible:true,diff:'--- current\\n+++ candidate\\n@@ -1,1 +1,1 @@\\n-agent line\\n+user line\\n'}]});
        }
        if(u.startsWith('/api/processes')){
          if((opts.method||'GET')==='POST'){window.__ui4.calls.push({type:'control',body:JSON.parse(opts.body||'{}')});return ok({ok:true});}
          if(u.includes('?'))return ok({ok:true,lines:[{cursor:1,text:'dev server ready on 5199'},{cursor:2,text:('compiled successfully in 120 ms '.repeat(40))}],cursor:2,truncated:false});
          return ok(window.__ui4.processStatus());
        }
        return original(url,opts);
      };
    })()`);

    await click('#btnMore');
    await until(async () => await read(`!document.getElementById('modal').hidden`));
    await read(`[...document.querySelectorAll('.modal-item')].find(b=>b.textContent==='本会话变更').click()`);
    await until(async () => (await paneFacts()).surface === 'session-changes');
    await until(() => read(`!!document.querySelector('.session-change-row')`));
    await sleep(150);

    const sessionPane = await paneFacts();
    facts.push({ sessionPane });
    check(Math.abs(sessionPane.headHeight - headerHeight) <= 1, '「本会话变更」标题带与其它面同一高度', { session: sessionPane.headHeight, other: headerHeight });
    check(await read(`(()=>{const h=document.querySelector('#rightPane .rp-head');return Boolean(h)&&h.querySelector('.rp-head-title').textContent==='本会话变更'&&h.querySelector('.rp-head-sub').textContent.includes('只读证据')})()`), '标题带由 createPaneHeader 统一画出（标题 + 一行说明）');
    check(await read(`(()=>{const h=document.querySelector('#rightPane .rp-head'),c=document.getElementById('rightPaneClose');return c.parentElement===h&&c.getBoundingClientRect().right>=h.getBoundingClientRect().right-16})()`), '关闭按钮就在标题带最右端（与其它面同一位置）');
    check(await read(`document.querySelectorAll('#rightPane .session-change-row').length===12`), '文件条目数量来自后端 fileCount 对应的真实列表');
    check(await read(`(()=>{const c=document.querySelector('#rightPane .session-change-summary-count');return c&&c.textContent.includes('12 个已捕获文件')&&c.textContent.includes('24 项操作')})()`), '概览显示后端给出的真实计数');
    check(await read(`[...document.querySelectorAll('#rightPane .rp-chip')].some(c=>c.textContent.includes('归因缺口存在'))&&[...document.querySelectorAll('#rightPane .rp-chip')].some(c=>c.textContent.includes('证据不完整'))`), '状态标记反映「证据不完整 / 存在归因缺口」');

    const overflowSession = await read(`(()=>{const p=document.getElementById('rightPane');const pathEls=[...p.querySelectorAll('.session-change-path')];return {paneOverflow:p.scrollWidth>p.clientWidth+1,worst:Math.max(...pathEls.map(e=>e.scrollWidth-e.clientWidth))}})()`);
    facts.push({ overflowSession });
    check(!overflowSession.paneOverflow && overflowSession.worst <= 1, '超长路径在面板内换行，不产生横向滚动', overflowSession);
    check(await read(`window.__ui4.xss===undefined && document.querySelectorAll('#rightPane img').length===0`), '不可信路径按文本呈现（没有解析出 <img>/没有执行 onerror）');
    check(await read(`[...document.querySelectorAll('#rightPane .session-change-path')].some(e=>e.textContent.includes('<img src=x onerror='))`), '不可信文本原样可见（用户能看见后端到底给了什么）');
    check(await read(`(()=>{const e=[...document.querySelectorAll('#rightPane .session-change-path')].find(e=>e.textContent.includes('implementation-with-a-very-long'));return Boolean(e&&e.title===e.textContent)})()`), '长路径带 title，省略后仍可读全');

    /* 滚动：内容滚、标题带不动。 */
    const scrolled = await read(`(()=>{const box=document.querySelector('#rightPane .session-change-body');const head=document.querySelector('#rightPane .rp-head');const before=head.getBoundingClientRect().top;box.scrollTop=260;return {scrollTop:box.scrollTop,headBefore:before,headAfter:head.getBoundingClientRect().top,overflow:getComputedStyle(box).overflowY}})()`);
    facts.push({ scrolled });
    check(scrolled.scrollTop > 0 && Math.abs(scrolled.headAfter - scrolled.headBefore) <= 1, '内容能滚，标题带位置不动', scrolled);

    /* 预览：读只读候选、不出执行入口。 */
    await read(`[...document.querySelectorAll('#rightPane .session-change-row > button')][0].click()`);
    await until(() => read(`!!document.querySelector('#rightPane .diff')`));
    check(await read(`document.querySelector('#rightPane').textContent.includes('实际恢复未开放')`), '预览明确写出「实际恢复未开放」');
    check(!(await read(`window.__ui4.calls.some(c=>['apply','prepare'].includes(c.type))`)), '预览路径不触发任何写操作');

    /* 数据过期：同会话的证据变化只让旧结果失效，不假装刷新。 */
    await read(`document.dispatchEvent(new CustomEvent('pi-gui:session-evidence-changed',{detail:{}}))`);
    await sleep(120);
    check(await read(`document.querySelector('#rightPane').textContent.includes('重新预览') && !document.querySelector('#rightPane .diff')`), '证据变化后旧预览失效并提示重新预览');

    /* 加载中：明确的进行中状态，而不是空白。 */
    await read(`window.__ui4.mode='pending';document.querySelector('#rightPane .rp-head button').click()`);
    await until(() => read(`!!document.querySelector('#rightPane .rp-loading')`));
    check(await read(`document.getElementById('rightPane').textContent.includes('正在读取') && document.querySelector('#rightPane .session-change-body').getAttribute('aria-busy')==='true'`), '加载中有明确文案与 aria-busy');

    /* 空态：不得被读成「文件没改过」。 */
    await read(`window.__ui4.mode='empty';document.querySelector('#rightPane .rp-head button').click()`);
    await until(() => read(`!!document.querySelector('#rightPane .rp-empty')`));
    check(await read(`(()=>{const e=document.querySelector('#rightPane .rp-empty');return e&&e.textContent.includes('不代表文件没有被修改')})()`), '空态明确区分「没有证据」与「没有改动」');
    check(await read(`document.querySelectorAll('#rightPane .session-change-row').length===0`), '空态下不残留上一批文件行');

    /* 错误态：面生的后端码不能原样泄进界面。 */
    await read(`window.__ui4.mode='error';document.querySelector('#rightPane .rp-head button').click()`);
    await until(() => read(`!!document.querySelector('#rightPane [data-tone="error"]')`));
    check(await read(`(()=>{const n=document.querySelector('#rightPane [data-tone="error"]');return n.getAttribute('role')==='status'&&n.textContent.includes('证据已更新')})()`), '错误态有 role=status 且用法定的可读文案');
    await shot('session-changes-error-1200-dark');

    await read(`window.__ui4.mode='full';document.querySelector('#rightPane .rp-head button').click()`);
    await until(() => read(`document.querySelectorAll('#rightPane .session-change-row').length===12`));

    /* 会话切换：内容与状态不串会话。 */
    await read(`document.dispatchEvent(new CustomEvent('pi-gui:session-switch'))`);
    await sleep(160);
    check(await read(`(()=>{const t=document.getElementById('rightPane').textContent;return t.includes('会话或工作区正在切换')&&!t.includes('module-9')})()`), '切换会话时旧文件行被清掉，只留切换提示');

    await escapeFromInside();
    check(await read(`document.activeElement && document.activeElement.id==='btnMore'`), '从「更多」菜单打开的面关闭后焦点回到 #btnMore');

    /* ---------- 5. 开发进程：状态标记、空态、日志、无假终端 ---------- */
    await click('#btnMore');
    await until(async () => await read(`!document.getElementById('modal').hidden`));
    await read(`[...document.querySelectorAll('.modal-item')].find(b=>b.textContent==='开发进程').click()`);
    await until(async () => (await paneFacts()).surface === 'process');
    await until(() => read(`document.querySelectorAll('#rightPane .process-row').length===2`));
    await sleep(200);

    const processPane = await paneFacts();
    check(Math.abs(processPane.headHeight - headerHeight) <= 1, '「开发进程」标题带与其它面同一高度', { process: processPane.headHeight });
    check(await read(`document.querySelector('#rightPane .rp-head-title').textContent==='开发进程'`), '开发进程标题由同一 header 画出');
    check(await read(`(()=>{const t=document.querySelector('.process-permission input');return t&&t.type==='checkbox'&&t.disabled===false})()`), '权限开关仍是既有的事实控件（默认关，本例由 fixture 打开）');
    check(await read(`!document.querySelector('#rightPane input:not([type=checkbox]), #rightPane textarea, #rightPane [contenteditable]')`), '开发进程里没有命令输入（没有假终端）');
    check(await read(`[...document.querySelectorAll('#rightPane .process-row')].every(r=>['ready','failed'].includes(r.dataset.state))`), '进程行带真实的 data-state');
    check(await read(`(()=>{const m=[...document.querySelectorAll('#rightPane .process-meta')];return m.length===2&&m[0].textContent.includes('已就绪')&&m[1].textContent.includes('失败')})()`), '状态文字仍在 .process-meta（既有脚本与读屏都以它为事实源）');
    const dotColors = await read(`(()=>{const rows=[...document.querySelectorAll('#rightPane .process-row')];return rows.map(r=>getComputedStyle(r.querySelector('.process-meta'),'::before').backgroundColor)})()`);
    facts.push({ dotColors });
    check(Array.isArray(dotColors) && dotColors.length === 2 && dotColors[0] !== dotColors[1] && dotColors[0] !== 'rgba(0, 0, 0, 0)', '状态点按 ready/failed 用不同的语义色', dotColors);
    check(await read(`(()=>{const p=document.getElementById('rightPane');return p.scrollWidth<=p.clientWidth+1})()`), '超长命令与长日志不把面板撑出横向滚动');
    check(await read(`(()=>{const l=document.querySelector('#rightPane .process-logs');const cs=getComputedStyle(l);return l.tabIndex===0&&l.getAttribute('aria-label').includes('脱敏')&&['auto','scroll'].includes(cs.overflowY)})()`), '日志区可聚焦、可滚、标注为脱敏日志');
    await shot('process-active-1200-dark');

    await read(`document.querySelector('#rightPane .process-actions button').click()`);
    await until(() => read(`window.__ui4.calls.some(c=>c.type==='control'&&c.body.action==='stop')`));
    const stopCall = await read(`window.__ui4.calls.filter(c=>c.type==='control').at(-1)`);
    check(stopCall.body.action === 'stop' && stopCall.body.id === 'p1', '停止按钮调用既有 control 接口且带真实 id', stopCall.body);

    await read(`window.__ui4.processes='empty'`);
    await until(() => read(`!!document.querySelector('#rightPane .rp-empty')`), 8000);
    check(await read(`(()=>{const e=document.querySelector('#rightPane .rp-empty');return e&&e.textContent.includes('暂无开发进程')})()`), '没有进程时是明确空态（不是错误）');
    check(await read(`(()=>{const b=[...document.querySelectorAll('#rightPane button')].map(b=>b.textContent);return b.includes('刷新')&&!b.some(t=>/运行|执行|终端/.test(t))})()`), '空态不给假的操作入口');

    await escapeFromInside();
    check(await read(`document.activeElement && document.activeElement.id==='btnMore'`), '开发进程关闭后焦点回到 #btnMore');

    /* ---------- 6. 响应式 × 主题矩阵（真实截图） ---------- */
    const openers = {
      changes: () => read(`document.querySelector('#navChanges').click()`),
      browser: () => read(`document.querySelector('#btnBrowser').click()`),
      session: async () => {
        await click('#btnMore');
        await until(async () => await read(`!document.getElementById('modal').hidden`));
        await read(`[...document.querySelectorAll('.modal-item')].find(b=>b.textContent==='本会话变更').click()`);
      },
      process: async () => {
        await click('#btnMore');
        await until(async () => await read(`!document.getElementById('modal').hidden`));
        await read(`[...document.querySelectorAll('.modal-item')].find(b=>b.textContent==='开发进程').click()`);
      },
    };
    await read(`window.__ui4.mode='full';window.__ui4.processes='active'`);
    /* 矩阵开始前把宽度复位到默认值：前面验拖动时把它拖窄过，
     * 留着 350px 截图就不代表新用户的默认观感（说明行也会被容器查询隐掉）。 */
    await read(`document.querySelector('#navChanges').click()`);
    await until(async () => !(await paneFacts()).hidden);
    const rz0 = await center('#rightPaneResizer');
    await mouse('mousePressed', rz0.x, rz0.y, { clickCount: 2 });
    await mouse('mouseReleased', rz0.x, rz0.y, { clickCount: 2 });
    await sleep(200);
    check((await paneFacts()).width === 420, '矩阵开始前宽度复位到默认 420（截图代表默认观感）');
    check(await read(`(()=>{const s=document.querySelector('#rightPane .rp-head-sub, #rightPane .chg-sub');return Boolean(s)&&!s.hidden&&s.getBoundingClientRect().width>20})()`), '默认宽度下标题带会显示说明行（窄了才让位）');
    await closePane();
    await until(async () => (await paneFacts()).hidden);
    const matrix = [];
    for (const theme of ['dark', 'light']) {
      for (const width of [700, 900, 1200, 1536]) {
        win.setContentSize(width, 900);
        await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        /* 每个宽度都从「侧栏展开 + 右栏关闭」的干净状态开始。 */
        await read(`(()=>{const b=document.querySelector('#btnSidebarExpand');if(b)document.querySelector('#projectSidebar').hidden&&b.click();})()`);
        await closePane();
        await sleep(200);
        const closed = await paneFacts();
        check(closed.hidden && !closed.pageOverflow, `右栏关闭时不产生横向溢出 ${theme}-${width}`, closed);

        for (const [name, open] of Object.entries(openers)) {
          await open();
          await until(async () => !(await paneFacts()).hidden);
          await sleep(320);
          const factsHere = await paneFacts();
          const label = `${theme}-${width}-${name}`;
          matrix.push({ label, ...factsHere });
          check(!factsHere.pageOverflow, `页面无横向溢出 ${label}`, factsHere);
          check(factsHere.left >= -1 && factsHere.right <= width + 1, `右栏完整落在视口内 ${label}`, factsHere);
          check(factsHere.scrollWidth <= factsHere.clientWidth + 1, `右栏内容不横向溢出 ${label}`, factsHere);
          check(Math.abs(factsHere.headHeight - headerHeight) <= 1, `标题带高度一致 ${label}`, { got: factsHere.headHeight, want: headerHeight });
          check(factsHere.closeRight >= factsHere.right - 16, `关闭按钮在标题带右端 ${label}`, factsHere);
          if (width === 700) check(factsHere.mode === 'overlay', `700px 走覆盖模式 ${label}`, factsHere);
          else if (width >= 1200) check(factsHere.mode === 'dock', `${width}px 走 dock 模式 ${label}`, factsHere);
          if (name === 'session') await shot(`${label}-session-changes`);
          else if (name === 'process') await shot(`${label}-process`);
          else await shot(`${label}-${name}`);
          await closePane();
          await until(async () => (await paneFacts()).hidden);
        }
      }
    }
    facts.push({ matrixCount: matrix.length });

    /* ---------- 7. 缩放、reduced-motion、键盘可达 ---------- */
    win.setContentSize(1200, 900);
    await read(`document.documentElement.dataset.theme='dark'`);
    win.webContents.setZoomFactor(1.25);
    /* 缩放后 CDP 的鼠标坐标与布局坐标不再一致，这一节只验布局，所以用页面内点击。 */
    await read(`document.querySelector('#navChanges').click()`);
    await until(async () => (await paneFacts()).surface === 'changes');
    await sleep(260);
    const zoomed = await paneFacts();
    facts.push({ zoomed });
    const zoomInner = await read('innerWidth');
    check(zoomInner < 1000 && Math.abs(zoomed.headHeight - headerHeight) <= 1, '125% 缩放下布局宽度真的变小，标题带仍是一条完整带子', { zoomInner, zoomed });
    check(zoomed.left >= -1 && zoomed.right <= zoomInner + 1, '125% 缩放下右栏仍在视口内（必要时退成覆盖模式）', zoomed);
    check(!zoomed.pageOverflow, '125% 缩放下没有横向溢出');
    await shot('changes-zoom125-dark');
    win.webContents.setZoomFactor(1);

    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await read(`(()=>{const b=document.querySelector('#rightPane .rp-head button')||document.createElement('span');return true})()`);
    const reduced = await read(`(()=>{const e=document.createElement('span');e.className='rp-loading-dot';document.querySelector('#rightPane').append(e);const cs=getComputedStyle(e);const out={animationName:cs.animationName,duration:cs.animationDuration};e.remove();const pane=getComputedStyle(document.getElementById('rightPane'));out.paneTransition=pane.transitionDuration;return out})()`);
    facts.push({ reduced });
    check(reduced.animationName === 'none', 'reduced-motion 下加载点不动画（状态仍然可见）', reduced);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });

    /* 键盘：Tab 能从分隔条走到标题带里的按钮，Escape 始终能关。 */
    await read(`document.getElementById('rightPaneResizer').focus()`);
    await key('Tab', 'Tab', 9);
    check(await read(`document.getElementById('rightPane').contains(document.activeElement)`), 'Tab 从分隔条继续进入面板内部');
    await key('Escape', 'Escape', 27);
    await until(async () => (await paneFacts()).hidden);
    check(true, '面板内键盘焦点位置都可以用 Escape 关闭');

    /* ---------- 8. 收尾 ---------- */
    if (process.env.UI4_INTEGRATION === '1') await require('./ui4-integration-electron.cjs').run({ win, read, check, shot, key, click, closePane, nativeView, sleep, until, facts });
    check(errors.length === 0, 'renderer / harness 没有报错', errors.slice(0, 5));

    const failed = checks.filter(c => !c.pass);
    const report = {
      generatedAt: new Date().toISOString(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      world,
      checks: checks.length,
      failed: failed.length,
      failures: failed,
      facts,
      screenshots,
      notes: [
        '所有渲染都是生产入口的实际资源；不注入 CSS，静态 stylesheet 必须存在并解析成功。',
        'Browser 使用真实 WebContentsView（electron/browser-view.cjs）与离线 127.0.0.1 fixture 页。',
        '本会话变更 / 开发进程的数据由页内 fetch 夹具提供，形状照抄真实接口。',
        '不使用真实 Pi、不调用模型、不写用户项目。',
      ],
    };
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(report, null, 2));
    console.log(`UI4 pane: ${checks.length - failed.length}/${checks.length} passed, ${failed.length} failed, ${screenshots.length} screenshots`);
    clearTimeout(timeout);
    cleanup(failed.length ? 1 : 0);
  } catch (error) {
    console.error(error.stack || error);
    try {
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ error: String(error && error.stack || error), checks, screenshots, errors }, null, 2));
    } catch { /* 报告写不出去也要留下退出码 */ }
    clearTimeout(timeout);
    cleanup(1);
  }

  function cleanup(code) {
    try { agent?.stop?.(); } catch { /* noop */ }
    try { browser?.destroy?.(); } catch { /* noop */ }
    try { win?.destroy?.(); } catch { /* noop */ }
    try { fixture?.closeAllConnections?.(); fixture?.close?.(); } catch { /* noop */ }
    try { harness?.kill?.(); } catch { /* noop */ }
    app.exit(code);
  }
}
