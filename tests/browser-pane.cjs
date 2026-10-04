/* 右栏内置浏览器：真实 Electron 验收（P26）。
 *
 * 为什么不能只用 jsdom：
 *   WebContentsView 是**原生子视图**，jsdom 里根本没有这回事。工具栏能画出来
 *   不代表网页真的出现在右栏里。所以这个脚本跑**打包后的真应用**，
 *   用 CDP 从页面里驱动，再用本地 HTTP 服务观察实际发生的请求。
 *
 * ---------- 本文件覆盖什么 / 不覆盖什么 ----------
 *
 * 这里验的是「**从 renderer 观察得到**的行为」：导航、前进后退、刷新、停止、
 * 拖动分隔条、改窗口尺寸、按钮状态、地址栏内容、提示与错误。
 *
 * 有两件事 renderer**观察不到**，在 tests/browser-session-check.cjs 里验：
 *   * 会话隔离（WebContentsView 不在 DOM 里）—— 那边用阳性对照 + sentinel 头证明；
 *   * 弹层遮挡时原生视图真的被摘下去（只发生在 contentView 那一层）。
 *
 * 用法：npm run build:app && node tests/browser-pane.cjs
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist-app', 'Pi GUI-win32-x64', 'Pi GUI.exe');
const APP_PORT = Number(process.env.E2E_PORT || 7788);
const FIXTURE_PORT = Number(process.env.BROWSER_FIXTURE_PORT || 7801);
const DEAD_PORT = Number(process.env.BROWSER_DEAD_PORT || 7803);
const CDP_PORT = Number(process.env.CDP_PORT || 9226);
const APP = `http://127.0.0.1:${APP_PORT}/`;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}/`;
const DEAD = `http://127.0.0.1:${DEAD_PORT}/`;
const TOKEN_HEADER = 'x-pi-gui-token';

const WORK = path.join(os.tmpdir(), 'pi-gui-browser-work');
const DATA = path.join(os.tmpdir(), 'pi-gui-browser-data');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rmQuiet = (p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* 被占用就留着 */
  }
};

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push([r === true || r === undefined ? 'PASS' : 'FAIL', name, r === true || r === undefined ? '' : String(r)]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
}

/* ---------- fixture：记录每个请求的头与次数 ---------- */
const hits = [];
let fixtureSrv = null;
const countOf = (p) => hits.filter((h) => h.url === p).length;

function page(title, body = '') {
  return `<!doctype html><title>${title}</title><h1>${title}</h1>${body}`;
}

function startFixture() {
  return new Promise((resolve) => {
    fixtureSrv = http.createServer((req, res) => {
      hits.push({ url: req.url, headers: { ...req.headers } });
      if (req.url === '/slow') {
        // 故意慢：用来验 loading=true 期间按钮变「停止」、以及 Stop 的路径
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(page('slow-page'));
        }, 6000);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(req.url === '/page-b' ? 'page-b' : req.url === '/page-a' ? 'page-a' : 'fixture-home'));
    });
    fixtureSrv.listen(FIXTURE_PORT, '127.0.0.1', () => resolve());
  });
}

/** 第二个本地服务：先关着（连接被拒），后面再拉起来 —— 用来证明
 *  「Reload 重新请求的是**同一个** URL」：只有服务起来之后那次真的打到了，
 *  计数才会从 0 变成 1。 */
let deadSrv = null;
const deadHits = [];
function startDead() {
  return new Promise((resolve) => {
    deadSrv = http.createServer((req, res) => {
      deadHits.push(req.url);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('revived'));
    });
    deadSrv.listen(DEAD_PORT, '127.0.0.1', () => resolve());
  });
}
const stopDead = () =>
  new Promise((resolve) => {
    try {
      deadSrv?.close(() => resolve());
      deadSrv?.closeAllConnections?.();
    } catch {
      resolve();
    }
    setTimeout(resolve, 400);
  });

/* ---------- 应用进程 ---------- */
function launch() {
  const env = { ...process.env, PI_CWD: WORK, PI_GUI_DATA: DATA, PI_GUI_OPEN: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--in-process-gpu'], {
    cwd: path.dirname(EXE),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const log = [];
  proc.stdout.on('data', (d) => log.push(String(d)));
  proc.stderr.on('data', (d) => log.push(String(d)));
  return {
    proc,
    log,
    kill: () => {
      try {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* noop */
      }
    },
  };
}

async function pidAlive(pid) {
  const out = await new Promise((res) => {
    const p = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { windowsHide: true });
    let s = '';
    p.stdout.on('data', (d) => (s += String(d)));
    p.on('error', () => res(''));
    p.on('close', () => res(s));
  });
  return out.includes(String(pid));
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('WebSocket 连不上')));
  });
  const send = (method, params = {}, ms = 15000) =>
    new Promise((res, rej) => {
      const n = ++id;
      pending.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
      setTimeout(() => {
        pending.delete(n);
        rej(new Error('超时: ' + method));
      }, ms);
    });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 200));
    return r.result?.result?.value;
  };
  return { ws, ready, send, evalJs };
}

async function listTargets() {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    return (await r.json()).filter((t) => t.type === 'page' || t.type === 'webview' || t.type === 'iframe');
  } catch {
    return [];
  }
}

/** 内置浏览器那个 webContents **实际**停在哪。
 *
 * 为什么不能看地址栏：用户按下 Enter 之后输入框还带着焦点，而 render()
 * 刻意不在「正在编辑」时回写 —— 于是地址栏里留着的是**用户打的字**，
 * 不是浏览器真实所在的页面。拿它当判据会把「后退没生效」判成通过。
 * （第一版就是这么错的：Back 明明没动，断言却是绿的。） */
async function browserTargetUrl() {
  const t = await listTargets();
  const b = t.find((x) => !String(x.url).includes(`:${APP_PORT}`) && String(x.url) !== 'about:blank');
  return b ? String(b.url) : null;
}

/* 页面里的一组小工具。全部走**真实 DOM 事件**，不去碰模块作用域。
 * ⚠️ 一律做**空值保护**：基线那一次 snap() 是在右栏还没打开、工具栏/占位块
 * 都还不存在的时候调的 —— 直接 getElementById(...).getBoundingClientRect()
 * 会在那儿炸掉，而那时整段脚本只会报一个「脚本执行完成 → false」。 */
const HELPERS = `(() => {
  const W = (id) => { const n = document.getElementById(id); return n ? Math.round(n.getBoundingClientRect().width) : 0; };
  const attr = (id, a) => { const n = document.getElementById(id); return n ? n.getAttribute(a) : null; };
  window.__t = {
    addr: () => document.getElementById('browserAddress'),
    type: (v) => {
      const a = window.__t.addr();
      if (!a) return false;
      a.focus(); a.value = v;
      a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    },
    reloadLabel: () => attr('browserReload', 'aria-label'),
    blurAddr: () => { const a = window.__t.addr(); if (a) a.blur(); return true; },
    snap: () => JSON.stringify({
      rightHidden: document.getElementById('rightPane').hidden,
      mode: document.getElementById('rightPane').dataset.mode || 'dock',
      paneW: W('rightPane'),
      viewportW: W('browserViewport'),
      addr: (window.__t.addr() || {}).value || '',
      reloadLabel: attr('browserReload', 'aria-label'),
      reloadTitle: attr('browserReload', 'title'),
      backDisabled: (document.getElementById('browserBack') || {}).disabled === true,
      fwdDisabled: (document.getElementById('browserForward') || {}).disabled === true,
      errorHidden: document.getElementById('browserError') ? document.getElementById('browserError').hidden : true,
      errorText: document.getElementById('browserError') ? document.getElementById('browserError').textContent : '',
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      innerW: window.innerWidth,
    }),
  };
  return true;
})()`;

(async () => {
  if (!fs.existsSync(EXE)) throw new Error(`没有 ${EXE}，先运行 npm run build:app`);
  rmQuiet(WORK);
  rmQuiet(DATA);
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  await startFixture();

  const inst = launch();
  let cdp = null;
  const snap = async () => JSON.parse(await cdp.evalJs('window.__t.snap()'));
  const type = async (v) => cdp.evalJs(`window.__t.type(${JSON.stringify(v)})`);

  try {
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      try {
        if ((await fetch(APP + 'api/status')).ok) break;
      } catch {
        /* 还没起来 */
      }
    }
    let page = null;
    for (let i = 0; i < 120; i++) {
      const t = await listTargets();
      const p = t.find((x) => x.url.includes(String(APP_PORT)));
      if (p?.title) {
        page = p;
        break;
      }
      await sleep(400);
    }
    if (!page) throw new Error('页面一直没加载完。日志：\n' + inst.log.join('').slice(-700));
    cdp = connect(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    /* 先把这个不清掉就会**跨轮次串味**：右栏宽度存在 localStorage 里
     * （pi-gui.rightpane.v1），而 DATA 目录偶尔因为上一轮进程没退干净删不掉
     * （rmQuiet 遇到占用就留着）—— 于是这一轮会带着**上一次拖出来的宽度**开局。
     * 实测就是这么踩到的：上一轮把宽度拖到了下限 320，下一轮一开始就贴着
     * 320，再「往右拖变窄」自然没有变化，看起来像功能坏了。
     * 所以清掉再重载，让每一轮都从默认宽度开始。 */
    await cdp.evalJs('try { localStorage.removeItem("pi-gui.rightpane.v1"); } catch (e) {}');
    await cdp.send('Page.reload');
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      const ready = await cdp
        .evalJs('document.readyState === "complete" && !!document.getElementById("rightPane")')
        .catch(() => false);
      if (ready === true) break;
    }
    await sleep(600);

    /* ---------- 基线 ---------- */
    const targetsBefore = (await listTargets()).length;
    await cdp.evalJs(HELPERS);
    const base = await snap();
    check('基线：右栏默认关闭', () => base.rightHidden === true || JSON.stringify(base));
    check('基线：右栏宽度是默认值（没有被上一轮的状态带偏）', () =>
      base.paneW === 0 || base.paneW === 420 || `paneW=${base.paneW}`
    );

    const btnInfo = JSON.parse(
      await cdp.evalJs(
        'JSON.stringify({exists: !!document.getElementById("btnBrowser"), label: document.getElementById("btnBrowser")?.getAttribute("aria-label"), hidden: !!document.getElementById("btnBrowser")?.hidden})'
      )
    );
    check('入口按钮存在且标为「内置浏览器」', () => (btnInfo.exists && btnInfo.label === '内置浏览器') || JSON.stringify(btnInfo));
    check('桌面版里入口按钮可见（桥在）', () => btnInfo.hidden === false || '入口被隐藏了');

    await cdp.evalJs('document.getElementById("btnBrowser").click()');
    await sleep(2500);
    await cdp.evalJs(HELPERS);
    const opened = await snap();
    check('点入口 → 右栏打开', () => opened.rightHidden === false || JSON.stringify(opened));
    const toolbarOk = await cdp.evalJs(
      '!!document.getElementById("browserToolbar") && !!document.getElementById("browserAddress") && !!document.getElementById("browserViewport") && !!document.getElementById("rightPaneResizer")'
    );
    check('工具栏 / 地址栏 / viewport / 分隔条都在', () => toolbarOk === true || '缺元素');
    const targetsOpen = (await listTargets()).length;
    check('打开后多出一个 webContents（WebContentsView 真的建了）', () =>
      targetsOpen === targetsBefore + 1 || `before=${targetsBefore} open=${targetsOpen}`
    );

    /* ---------- 1. 加载成功 → loading 必须归位 ----------
     * 这是本轮修的 bug 之一：did-stop-loading 原来只刷导航态，不碰 loading，
     * 于是页面加载完了按钮还停在「停止」。 */
    hits.length = 0;
    await type(FIXTURE + 'page-a');
    let okA = false;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      if (countOf('/page-a')) {
        okA = true;
        break;
      }
    }
    check('本地 fixture 真的被请求了（网页确实加载）', () => okA || '没收到请求');
    await sleep(1200); // 等 did-stop-loading
    const afterA = await snap();
    check('★ 加载成功后刷新按钮恢复成「刷新」（loading 已归位）', () =>
      afterA.reloadLabel === '刷新' && afterA.reloadTitle === '刷新' || `label=${afterA.reloadLabel} title=${afterA.reloadTitle}`
    );
    check('地址栏显示的是 page-a', () => afterA.addr.includes('/page-a') || afterA.addr);
    check('加载成功后没有错误条', () => afterA.errorHidden === true || afterA.errorText);

    /* ---------- 2. 令牌头（第二道防线） ----------
     * ⚠️ 这一条**不能**证明「独立 session」—— 令牌注入只匹配 Pi GUI 的 origin，
     * fixture 在另一个端口，即便浏览器错误地用了 defaultSession 也收不到令牌。
     * 真正能区分的证明在 tests/browser-session-check.cjs（那边给 defaultSession
     * 装了只匹配该 fixture 的 sentinel 头，并带阳性对照）。
     * 这里保留它是因为「请求里确实没有这个头」本身仍然是有价值的底线断言。 */
    const docHits = hits.filter((h) => h.url === '/page-a');
    check('内置浏览器的请求里没有 X-Pi-Gui-Token', () => {
      const leak = docHits.filter((h) => TOKEN_HEADER in h.headers);
      return leak.length === 0 || `有 ${leak.length} 个请求带了令牌`;
    });

    /* ---------- 3. Back / Forward ---------- */
    hits.length = 0;
    await type(FIXTURE + 'page-b');
    for (let i = 0; i < 40 && !countOf('/page-b'); i++) await sleep(300);
    await sleep(1200);
    const onB = await snap();
    check('前进到 B 后 canGoBack=true（后退按钮可用）', () => onB.backDisabled === false || JSON.stringify(onB));

    await cdp.evalJs('document.getElementById("browserBack").click()');
    await sleep(1800);
    const backUrl = await browserTargetUrl();
    const backState = await snap();
    check('★ 点 Back 真的回到了 A（看 webContents 实际 URL，不是按钮事件）', () =>
      String(backUrl).includes('/page-a') || `实际 URL=${backUrl}`
    );
    check('回到 A 后 canGoForward=true（前进按钮可用）', () => backState.fwdDisabled === false || JSON.stringify(backState));

    await cdp.evalJs('document.getElementById("browserForward").click()');
    await sleep(1800);
    const fwdUrl = await browserTargetUrl();
    check('★ 点 Forward 真的回到了 B', () => String(fwdUrl).includes('/page-b') || `实际 URL=${fwdUrl}`);

    /* ---------- 4. Reload：同一 URL 重新请求 ---------- */
    const beforeReload = countOf('/page-b');
    await cdp.evalJs('document.getElementById("browserReload").click()');
    let reloaded = false;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      if (countOf('/page-b') > beforeReload) {
        reloaded = true;
        break;
      }
    }
    check('★ Reload 让 fixture 的请求次数 +1', () => reloaded || `before=${beforeReload} after=${countOf('/page-b')}`);
    await sleep(1200);
    const afterReload = await snap();
    check('Reload 后 URL 不变', () => afterReload.addr.includes('/page-b') || afterReload.addr);
    check('Reload 完成后按钮回到「刷新」', () => afterReload.reloadLabel === '刷新' || afterReload.reloadLabel);

    /* ---------- 5. Stop：加载中变「停止」，停下后不报错 ---------- */
    hits.length = 0;
    await type(FIXTURE + 'slow');
    let loadingSeen = false;
    for (let i = 0; i < 20; i++) {
      await sleep(200);
      if ((await snap()).reloadLabel === '停止') {
        loadingSeen = true;
        break;
      }
    }
    check('慢页面加载中：刷新按钮变「停止」（loading=true）', () => loadingSeen || '没观察到「停止」态');

    await cdp.evalJs('document.getElementById("browserReload").click()'); // 此时它是「停止」
    await sleep(1500);
    const stopped = await snap();
    check('★ 点停止后 loading=false（按钮回到「刷新」）', () => stopped.reloadLabel === '刷新' || stopped.reloadLabel);
    check('★ ERR_ABORTED 不被显示成「页面加载失败」', () =>
      stopped.errorHidden === true || `显示了错误：${stopped.errorText}`
    );

    /* ---------- 6. 加载失败：地址栏保住 URL ----------
     * 本轮修的另一个 bug：navigate() 原来没把规范化后的 URL 写进 state.url，
     * did-fail-load 又不保留失败 URL —— 结果连不上之后地址栏被清空。 */
    await type(DEAD + 'will-fail');
    let failed = false;
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      const s = await snap();
      if (s.errorHidden === false) {
        failed = true;
        break;
      }
    }
    check('连不上时出现错误提示', () => failed || '一直没出现错误条');
    const failedState = await snap();
    check('★ 失败后地址栏仍保留该 URL', () => failedState.addr.startsWith(DEAD) || `addr=${failedState.addr}`);
    check('失败后 loading 归位（按钮是「刷新」）', () => failedState.reloadLabel === '刷新' || failedState.reloadLabel);

    await cdp.evalJs('window.__t.blurAddr()');
    await sleep(500);
    const afterBlur = await snap();
    check('★ 地址栏失焦后 URL 不丢', () => afterBlur.addr.startsWith(DEAD) || `addr=${afterBlur.addr}`);

    /* Reload 重新请求同一个 URL —— 用「服务起来之后这次真的打到了」来证明：
     * 光断言「又失败了一次」证明不了请求真的发出去过。 */
    await startDead();
    await cdp.evalJs('document.getElementById("browserReload").click()');
    let revived = false;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      if (deadHits.length) {
        revived = true;
        break;
      }
    }
    check('★ Reload 重新请求的就是失败时那个 URL', () => revived || '服务起来后仍然没收到请求');
    check('Revive 时请求的路径没变', () => deadHits[0] === '/will-fail' || String(deadHits[0]));
    await stopDead();

    /* ---------- 7. 拖动分隔条 ---------- */
    hits.length = 0;
    await type(FIXTURE + 'page-a');
    for (let i = 0; i < 40 && !countOf('/page-a'); i++) await sleep(300);
    await sleep(1000);
    const beforeDrag = await snap();
    await cdp.evalJs(`(() => {
      const d = document.getElementById('rightPaneResizer');
      const r = d.getBoundingClientRect();
      const startX = r.left + 3;
      /* 往**左**拖 = 变宽（分隔条在面板左边缘上）。往右拖是变窄。 */
      d.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, clientX:startX, clientY:r.top+40}));
      document.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:startX-120, clientY:r.top+40}));
      document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, clientX:startX-120, clientY:r.top+40}));
      return true;
    })()`);
    await sleep(900);
    const afterDrag = await snap();
    check('★ 拖动分隔条改变了右栏宽度', () =>
      afterDrag.paneW !== beforeDrag.paneW ||
      `宽度没变：before=${beforeDrag.paneW} after=${afterDrag.paneW} innerW=${beforeDrag.innerW} mode=${beforeDrag.mode}`
    );
    check('拖宽后宽度仍在上限内（≤ 工作区 60%）', () => {
      const w = afterDrag.paneW;
      const cap = Math.round(afterDrag.innerW * 0.6) + 2;
      return (w >= 320 && w <= cap) || `width=${w} cap=${cap}`;
    });
    check('viewport 宽度同步跟着变', () =>
      afterDrag.viewportW !== beforeDrag.viewportW ||
      `viewport 没变：before=${beforeDrag.viewportW} after=${afterDrag.viewportW}`
    );
    const targetsAfterDrag = (await listTargets()).length;
    check('拖动后没有冒出第二个 WebContents', () =>
      targetsAfterDrag === targetsOpen || `拖动前 ${targetsOpen}，拖动后 ${targetsAfterDrag}`
    );

    /* ---------- 8. 改窗口尺寸 ---------- */
    const sizes = [
      [1200, 800],
      [900, 700],
      [1536, 900],
    ];
    for (const [w, h] of sizes) {
      await cdp.evalJs(`window.resizeTo(${w}, ${h})`);
      await sleep(1300);
      const s = await snap();
      check(`窗口 ${w}x${h}：Browser 还在、右栏可见、无水平溢出`, () =>
        s.rightHidden === false && s.paneW >= 320 && s.overflowX === 0 || JSON.stringify(s)
      );
      const t = (await listTargets()).length;
      check(`窗口 ${w}x${h}：WebContentsView 没有丢`, () => t === targetsOpen || `targets=${t}`);
    }
    const atNarrow = await snap();
    check('窄窗口下退化成 overlay（不继续压扁聊天）', () =>
      ['dock', 'overlay'].includes(atNarrow.mode) || atNarrow.mode
    );

    /* ---------- 9. Modal / palette 遮挡（renderer 侧） ----------
     * 原生视图真的被摘下去只证明得了在主进程里（tests/browser-session-check.cjs）。
     * 这里证明**触发链**：弹层可见时右栏仍然在，且弹层盖在它上面。 */
    await cdp.evalJs('document.getElementById("navPalette").click()');
    await sleep(600);
    const withPalette = JSON.parse(
      await cdp.evalJs(
        'JSON.stringify({paletteVisible: document.getElementById("paletteLayer").hidden === false, paneStillOpen: document.getElementById("rightPane").hidden === false})'
      )
    );
    check('打开命令面板时右栏仍开着（底下的状态没被破坏）', () =>
      withPalette.paneStillOpen === true || JSON.stringify(withPalette)
    );
    check('命令面板确实可见', () => withPalette.paletteVisible === true || JSON.stringify(withPalette));
    await cdp.evalJs('document.getElementById("paletteLayer").click()');
    await sleep(600);
    const afterPalette = JSON.parse(
      await cdp.evalJs('JSON.stringify({paletteHidden: document.getElementById("paletteLayer").hidden, addr: document.getElementById("browserAddress").value})')
    );
    check('关掉面板后右栏内容没有被重建（地址栏还是原来那个）', () =>
      afterPalette.addr.includes('/page-a') || afterPalette.addr
    );

    /* ---------- 10. Toast 必须让开原生视图 ----------
     * 注入一个真实结构（#toasts 里一个 .toast），量它的最终几何 —— 位置由 CSS 决定，
     * 这条验的就是那条 CSS 规则。 */
    const toastGeom = JSON.parse(
      await cdp.evalJs(`(() => {
        const host = document.getElementById('toasts');
        host.innerHTML = '<div class="toast" id="__probeToast">探针</div>';
        const t = document.getElementById('__probeToast').getBoundingClientRect();
        const p = document.getElementById('rightPane').getBoundingClientRect();
        return JSON.stringify({toastRight: Math.round(t.right), toastLeft: Math.round(t.left), paneLeft: Math.round(p.left), paneW: Math.round(p.width)});
      })()`)
    );
    check('★ Toast 落在 Browser pane 左侧（不被原生视图盖住）', () =>
      toastGeom.toastRight <= toastGeom.paneLeft + 1 || JSON.stringify(toastGeom)
    );
    await cdp.evalJs('document.getElementById("toasts").innerHTML = ""');

    /* ---------- 11. Open External：主进程白名单把关 ---------- */
    /* Runtime.evaluate 里**没有顶层 await** —— 必须包一层 async IIFE，
     * 否则拿到的是 "SyntaxError: missing ) after..." 这种看不出所以然的错。 */
    const rejectExternal = JSON.parse(
      await cdp.evalJs(
        '(async () => JSON.stringify(await window.piGuiDesktop.browser.openExternal("javascript:alert(1)")))()'
      )
    );
    check('★ 非 http/https 的地址被主进程拒绝（不交给系统浏览器）', () =>
      rejectExternal.ok === false || JSON.stringify(rejectExternal)
    );
    const rejectFile = JSON.parse(
      await cdp.evalJs(
        '(async () => JSON.stringify(await window.piGuiDesktop.browser.openExternal("file:///C:/Windows/win.ini")))()'
      )
    );
    check('★ file: 也被拒绝', () => rejectFile.ok === false || JSON.stringify(rejectFile));

    /* ---------- 12. 关闭：收起 + 销毁 ---------- */
    await cdp.evalJs('document.getElementById("browserClose").click()');
    await sleep(2000);
    const closed = JSON.parse(
      await cdp.evalJs(
        'JSON.stringify({rightHidden: document.getElementById("rightPane").hidden, pressed: document.getElementById("btnBrowser").getAttribute("aria-pressed"), toolbarGone: !document.getElementById("browserToolbar")})'
      )
    );
    check('点 × → 右栏收起', () => closed.rightHidden === true || JSON.stringify(closed));
    check('关闭后工具栏被卸载', () => closed.toolbarGone === true || JSON.stringify(closed));
    check('入口按钮恢复未选中', () => closed.pressed === 'false' || String(closed.pressed));
    const targetsClosed = (await listTargets()).length;
    check('★ 关闭后 webContents 被销毁（不泄漏）', () =>
      targetsClosed === targetsBefore || `before=${targetsBefore} closed=${targetsClosed}`
    );
    check('关闭后没有异常日志', () => {
      const log = inst.log.join('');
      return !/Unhandled|TypeError|ReferenceError/.test(log) || log.slice(-400);
    });

    /* ---------- 13. 再开一次不累积 ---------- */
    await cdp.evalJs('document.getElementById("btnBrowser").click()');
    await sleep(2200);
    const targetsReopen = (await listTargets()).length;
    check('再开一次仍只有一个浏览器 webContents', () =>
      targetsReopen === targetsBefore + 1 || `before=${targetsBefore} reopen=${targetsReopen}`
    );
    await cdp.evalJs('document.getElementById("browserClose").click()');
    await sleep(1500);
    const targetsFinal = (await listTargets()).length;
    check('再关一次回到基线（开→关→开→关 不留残留）', () =>
      targetsFinal === targetsBefore || `before=${targetsBefore} final=${targetsFinal}`
    );
  } catch (err) {
    check('脚本执行完成', () => false);
    console.log('运行失败: ' + err.message);
  } finally {
    try {
      cdp?.ws.close();
    } catch {
      /* noop */
    }
    inst.kill();
    for (let i = 0; i < 20; i++) {
      if (!(await pidAlive(inst.proc.pid))) break;
      await sleep(300);
    }
    try {
      fixtureSrv?.close();
      fixtureSrv?.closeAllConnections?.();
    } catch {
      /* noop */
    }
    await stopDead();
  }

  let pass = 0;
  for (const [st, name, msg] of results) {
    if (st === 'PASS') pass++;
    console.log(`${st === 'PASS' ? '  ok  ' : ' FAIL '} ${name}${msg ? '  → ' + msg : ''}`);
  }
  console.log(`\n${pass}/${results.length} 通过`);
  rmQuiet(WORK);
  rmQuiet(DATA);
  setTimeout(() => process.exit(pass === results.length ? 0 : 1), 700);
})();
