/* 右栏内置浏览器：真实 Electron 验收（P26）。
 *
 * 为什么不能只用 jsdom：
 *   WebContentsView 是**原生子视图**，jsdom 里根本没有这回事。工具栏能画出来
 *   不代表网页真的出现在右栏里。所以这个脚本跑**打包后的真应用**，
 *   用 CDP 从页面里驱动桥，再用第二个本地 HTTP 服务观察实际发出的请求。
 *
 * ---------- 这个脚本最关键的一条：令牌隔离 ----------
 *
 * 主窗口靠 defaultSession 的 onBeforeSendHeaders 给发往 `http://127.0.0.1:<PORT>/*`
 * 的请求**自动注入** X-Pi-Gui-Token —— 那是本应用最重要的安全边界。
 * 内置浏览器加载的是**任意网页**；只要它和主窗口共用一个 session，
 * 右栏里的页面请求本机后端时就会自动带上令牌。
 *
 * 所以这里起一个 fixture 服务，让它**记录收到的请求头**，然后证明：
 *   * 内置浏览器的请求**不带** X-Pi-Gui-Token；
 *   * 导航到 Pi GUI 自己的 origin 会被拦下。
 * 光靠读源码断言「没用 defaultSession」不够 —— 这一条是真的打了一次网络请求。
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
const CDP_PORT = Number(process.env.CDP_PORT || 9226);
const APP = `http://127.0.0.1:${APP_PORT}/`;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}/`;
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

/* ---------- fixture：记录收到的请求头 ---------- */
const hits = [];
let fixtureSrv = null;

function startFixture() {
  return new Promise((resolve) => {
    fixtureSrv = http.createServer((req, res) => {
      hits.push({ url: req.url, headers: { ...req.headers } });
      if (req.url === '/__hits') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(hits));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>local-dev-fixture</title><h1 id="ok">fixture page</h1>');
    });
    fixtureSrv.listen(FIXTURE_PORT, '127.0.0.1', () => resolve());
  });
}

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

/** 列出当前所有可调试 target —— 用来验「关了之后 webContents 真的没了」。 */
async function listTargets() {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    return (await r.json()).filter((t) => t.type === 'page' || t.type === 'webview' || t.type === 'iframe');
  } catch {
    return [];
  }
}

(async () => {
  if (!fs.existsSync(EXE)) throw new Error(`没有 ${EXE}，先运行 npm run build:app`);
  rmQuiet(WORK);
  rmQuiet(DATA);
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  await startFixture();

  const inst = launch();
  let cdp = null;
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

    /* ---------- 基线：右栏是关着的，也没有多余的 webContents ---------- */
    const targetsBefore = (await listTargets()).length;
    /* ⚠️ 断言必须收**已求值**的值：`() => cdp.evalJs(...) === true` 拿到的是
     * Promise，跟 true 比永远为假 —— 而 check 只看返回值真假，
     * 一个 Promise 是恒真的，于是这种写法会**假通过**。所以一律先 await。 */
    const baseHidden = await cdp.evalJs('document.getElementById("rightPane").hidden');
    check('基线：右栏默认关闭', () => baseHidden === true || `hidden=${baseHidden}`);

    const btnInfo = JSON.parse(
      await cdp.evalJs(
        'JSON.stringify({exists: !!document.getElementById("btnBrowser"), label: document.getElementById("btnBrowser")?.getAttribute("aria-label"), pressed: document.getElementById("btnBrowser")?.getAttribute("aria-pressed"), hidden: !!document.getElementById("btnBrowser")?.hidden})'
      )
    );
    check('入口按钮存在且标为「内置浏览器」', () => (btnInfo.exists && btnInfo.label === '内置浏览器') || JSON.stringify(btnInfo));
    check('桌面版里入口按钮可见（桥在）', () => btnInfo.hidden === false || '入口被隐藏了');

    /* ---------- 打开右栏（走真实入口按钮） ---------- */
    await cdp.evalJs('document.getElementById("btnBrowser").click()');
    await sleep(2500);

    const opened = JSON.parse(
      await cdp.evalJs(
        'JSON.stringify({rightHidden: document.getElementById("rightPane").hidden, pressed: document.getElementById("btnBrowser").getAttribute("aria-pressed"), toolbar: !!document.getElementById("browserToolbar"), address: !!document.getElementById("browserAddress"), viewport: !!document.getElementById("browserViewport"), divider: !!document.getElementById("rightPaneResizer")})'
      )
    );
    check('点入口 → 右栏打开', () => opened.rightHidden === false || JSON.stringify(opened));
    check('右栏打开后 toolbar / 地址栏 / viewport / 分隔条都在', () =>
      opened.toolbar && opened.address && opened.viewport && opened.divider || JSON.stringify(opened)
    );
    check('入口按钮切到选中态', () => opened.pressed === 'true' || String(opened.pressed));

    const targetsOpen = (await listTargets()).length;
    check('打开后多出一个 webContents（WebContentsView 真的建了）', () =>
      targetsOpen === targetsBefore + 1 || `before=${targetsBefore} open=${targetsOpen}`
    );

    /* ---------- 导航到本地 fixture ---------- */
    hits.length = 0;
    await cdp.evalJs(
      `(() => { const a = document.getElementById("browserAddress"); a.focus(); a.value = ${JSON.stringify(FIXTURE)}; a.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", bubbles:true})); return true; })()`
    );

    let loaded = false;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      if (hits.some((h) => h.url === '/')) {
        loaded = true;
        break;
      }
    }
    check('本地 fixture 真的被请求了（网页确实加载）', () => loaded || '没收到 fixture 请求');

    /* ---------- 令牌隔离（本脚本存在的主要理由） ---------- */
    const docHits = hits.filter((h) => h.url === '/');
    check('fixture 收到了带 host 的请求（确认不是别的来源）', () =>
      docHits.length > 0 && String(docHits[0].headers.host || '').startsWith('127.0.0.1') ||
      JSON.stringify(docHits[0]?.headers || {})
    );
    check('★ 内置浏览器的请求**不带** X-Pi-Gui-Token', () => {
      const leak = docHits.filter((h) => TOKEN_HEADER in h.headers);
      return leak.length === 0 || `有 ${leak.length} 个请求带了令牌 —— 独立 session 没生效`;
    });

    const addr = await cdp.evalJs('document.getElementById("browserAddress").value');
    check('地址栏显示的是 fixture 地址', () => String(addr).startsWith(FIXTURE) || String(addr));

    /* ---------- 导航到 Pi GUI 自己的 origin 必须被拦 ----------
     *
     * ⚠️ 断言不能看地址栏的值：用户刚打进去的字**本来就在那里**（正在编辑时
     * render() 故意不回写），所以「地址栏还是我打的字」证明不了任何事 ——
     * 第一版就是这么写的，它把一次真实的拦截判成了通过（假绿）。
     *
     * 真正要看的是**浏览器视图实际停在哪**：从 CDP 的 target 列表里找到那个
     * 加载着 fixture 的 target，它必须**还在 fixture 上**，没被切到应用 origin。 */
    hits.length = 0;
    await cdp.evalJs(
      `(() => { const a = document.getElementById("browserAddress"); a.focus(); a.value = ${JSON.stringify(APP)}; a.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", bubbles:true})); return true; })()`
    );
    await sleep(2500);

    const targetsAfterSelf = await listTargets();
    const browserTarget = targetsAfterSelf.find((t) => String(t.url).includes(`:${FIXTURE_PORT}`));
    check('★ 导航到 Pi GUI origin 被拒：浏览器视图仍停在 fixture 上', () => {
      if (!browserTarget) return `找不到停在 fixture 的 target：${JSON.stringify(targetsAfterSelf.map((t) => t.url))}`;
      return !String(browserTarget.url).includes(`:${APP_PORT}`) || `浏览器被导航到了 ${browserTarget.url}`;
    });
    const errorShown = await cdp.evalJs(
      'JSON.stringify({hidden: document.getElementById("browserError").hidden, text: document.getElementById("browserError").textContent})'
    );
    const errInfo = JSON.parse(errorShown);
    check('★ 被拒时界面给出明确提示（不是静默失败）', () =>
      errInfo.hidden === false && /拒绝/.test(errInfo.text) || JSON.stringify(errInfo)
    );

    /* ---------- 关闭：右栏收起 + webContents 销毁（不留泄漏） ---------- */
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

    /* ---------- 再开一次：反复开关不累积 ---------- */
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
