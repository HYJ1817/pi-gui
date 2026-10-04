/* 内置浏览器的主进程验收：会话隔离 + 弹层遮挡 + 关闭销毁。
 *
 * ---------- 为什么必须单独一个 harness，而不是并进 tests/browser-pane.cjs ----------
 *
 * browser-pane.cjs 用 CDP 驱动**页面**。但这两件事 renderer 根本观察不到：
 *   * WebContentsView 不在 DOM 里，页面看不见它；
 *   * 「弹层开着时原生视图被摘下去」只发生在 contentView 那一层。
 * 所以这个文件**用 electron 直接跑**，require 产品自己的 browser-view.cjs，
 * 在真正的主进程里做断言。
 *
 * ---------- 令牌隔离：为什么旧写法证明不了任何事 ----------
 *
 * 原来的做法是「让内置浏览器访问另一个 localhost fixture，断言 fixture 没收到
 * X-Pi-Gui-Token」。**那证明不了独立 session** —— main.cjs 的令牌注入只匹配
 * `Pi GUI ORIGIN/*`，fixture 在另一个端口上，**即便浏览器错误地用了 defaultSession，
 * 那条规则也匹配不到它**，于是无论如何都收不到令牌。测试必然通过，但什么都没验。
 *
 * 现在改成能真正区分的做法：
 *   1. 往 **defaultSession** 上装一个 sentinel 头，且 URL 过滤器**专门匹配这个 fixture**；
 *   2. 先做**阳性对照**：用 defaultSession 的 webContents 打开 fixture，
 *      必须收到 sentinel —— 这一步证明「sentinel 机制本身是有效的」；
 *   3. 再用**产品自己的 controller** 打开同一个 fixture，必须**收不到** sentinel。
 *
 * 阳性对照是关键：没有它，第 2 步忘了装、装错了、过滤器写歪了，第 3 步都会
 * 静默通过 —— 那又变成了一个「永远绿」的测试。
 *
 * sentinel 只活在这个文件里，产品代码一个字都不知道它。
 * 不把 AUTH_TOKEN 交给 renderer，也不给产品加任何 debug 接口。
 *
 * 用法：npm run test:browser-session
 */
const http = require('node:http');
const path = require('node:path');

const { app, BrowserWindow, ipcMain, session } = require('electron');
const { createBrowserController } = require('../electron/browser-view.cjs');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_PORT = Number(process.env.SESSION_FIXTURE_PORT || 7802);
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}/`;
const ORIGIN = 'http://127.0.0.1:7788'; // 本 harness 不起真后端，只作为策略参数
const SENTINEL = 'X-Pi-Gui-Test-Default-Session';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push([r === true || r === undefined ? 'PASS' : 'FAIL', name, r === true || r === undefined ? '' : String(r)]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
}

/* ---------- fixture：记录每个请求的头 ---------- */
const hits = [];
let fixtureSrv = null;

function startFixture() {
  return new Promise((resolve) => {
    fixtureSrv = http.createServer((req, res) => {
      hits.push({ url: req.url, headers: { ...req.headers } });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>session-fixture</title><h1>fixture</h1>');
    });
    fixtureSrv.listen(FIXTURE_PORT, '127.0.0.1', () => resolve());
  });
}

function hitsFor(url) {
  return hits.filter((h) => h.url === url);
}

async function waitForHit(url, ms = 12000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (hitsFor(url).length) return true;
    await sleep(200);
  }
  return false;
}

/** 在 defaultSession 上装 sentinel，过滤器**只匹配这个 fixture**。
 *  这样它不会顺手给产品后端或别的东西加头，也不会和产品的令牌规则互相干扰。 */
function installSentinel() {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${FIXTURE}*`] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, [SENTINEL]: '1' } });
  });
}

async function main() {
  await startFixture();
  await app.whenReady();
  installSentinel();

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const controller = createBrowserController({ origin: ORIGIN, getWindow: () => win, ipcMain });
  controller.register();

  /* ---------- 1. 阳性对照：defaultSession 必须收到 sentinel ----------
   *
   * 失败的后果要说清楚：这一条挂了就说明**测试装置本身**没生效，
   * 下面那条「浏览器没收到 sentinel」就不再有任何证明力。 */
  const control = new BrowserWindow({
    width: 600,
    height: 400,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  hits.length = 0;
  control.loadURL(FIXTURE + 'control').catch(() => {});
  const controlHit = await waitForHit('/control');
  check('阳性对照：fixture 收到请求（测试装置有效）', () => controlHit || `没收到；hits=${JSON.stringify(hits.map((h) => h.url))}`);
  const controlHeaders = hitsFor('/control')[0]?.headers || {};
  check('阳性对照：defaultSession 的请求**带**sentinel（机制真的生效）', () =>
    SENTINEL.toLowerCase() in controlHeaders || `收到的头：${JSON.stringify(Object.keys(controlHeaders))}`
  );

  /* ---------- 2. 产品：内置浏览器不能继承 defaultSession ---------- */
  check('controller.open() 建出视图', () => controller.open().ok === true);
  /* ⚠️ **不要**清空 hits —— 上面阳性对照那条记录还要用来做「两边打的是同一个
   * fixture」的交叉核对。两条路径的 URL 不同（/control vs /browser），
   * 用 hitsFor 就能分开，不需要清。 */
  const nav = controller.navigate(FIXTURE + 'browser');
  check('navigate 接受这个地址', () => nav.ok === true || JSON.stringify(nav));
  const browserHit = await waitForHit('/browser');
  check('内置浏览器真的加载了 fixture', () => browserHit || '没收到请求');

  const browserHeaders = hitsFor('/browser')[0]?.headers || {};
  check('★ 内置浏览器请求**不带** sentinel（没继承 defaultSession 的 webRequest）', () => {
    const got = SENTINEL.toLowerCase() in browserHeaders;
    return !got || `收到了 sentinel —— 浏览器会话与 defaultSession 串了：${JSON.stringify(browserHeaders)}`;
  });
  check('两条路径打的是同一个 fixture（对照有效）', () => {
    const c = hitsFor('/control')[0];
    const b = hitsFor('/browser')[0];
    return Boolean(c && b) || '有一侧没记录到请求';
  });

  /* ---------- 3. 弹层遮挡：真的从 contentView 摘下去 / 挂回来 ---------- */
  const childrenWithView = win.contentView.children.length;
  check('打开后 contentView 里多了一个子视图', () => childrenWithView >= 1 || `children=${childrenWithView}`);

  const urlBeforeOcclude = controller.getState().url;
  const hitsBeforeOcclude = hits.length;

  controller.setOccluded(true);
  const childrenOccluded = win.contentView.children.length;
  check('★ 遮挡时原生视图被摘下去', () =>
    childrenOccluded === childrenWithView - 1 || `children ${childrenWithView} → ${childrenOccluded}`
  );

  await sleep(600);
  controller.setOccluded(false);
  const childrenRestored = win.contentView.children.length;
  check('★ 关掉弹层后视图被挂回来', () =>
    childrenRestored === childrenWithView || `children ${childrenOccluded} → ${childrenRestored}`
  );
  check('★ 遮挡前后页面没有被重建 / 重新加载', () => {
    const sameUrl = controller.getState().url === urlBeforeOcclude;
    const noNewHits = hits.length === hitsBeforeOcclude;
    return (sameUrl && noNewHits) || `url ${urlBeforeOcclude} → ${controller.getState().url}，新增请求 ${hits.length - hitsBeforeOcclude}`;
  });

  /* ---------- 4. 关闭：销毁 webContents，不留残留 ---------- */
  const stateBeforeClose = controller.getState();
  check('关闭前 state.open 为 true', () => stateBeforeClose.open === true);
  controller.close();
  await sleep(900);
  check('关闭后 contentView 回到空', () =>
    win.contentView.children.length === childrenWithView - 1 ||
    `children=${win.contentView.children.length}（期望 ${childrenWithView - 1}）`
  );
  check('关闭后状态被清空', () => {
    const s = controller.getState();
    return (s.open === false && s.url === '' && s.loading === false) || JSON.stringify(s);
  });

  /* ---------- 5. 再开一次：开→关→开→关 不累积 ---------- */
  controller.open();
  const reopenChildren = win.contentView.children.length;
  check('再开后仍然只有一个浏览器子视图', () =>
    reopenChildren === childrenWithView || `children=${reopenChildren}，期望 ${childrenWithView}`
  );
  controller.close();
  await sleep(600);
  check('再关一次回到关闭态', () =>
    win.contentView.children.length === childrenWithView - 1 ||
    `children=${win.contentView.children.length}`
  );

  controller.destroy();
  try {
    control.destroy();
    win.destroy();
  } catch {
    /* noop */
  }
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (e) {
    check('harness 跑完', () => false);
    console.log('运行失败: ' + e.message);
  }
  let pass = 0;
  for (const [st, name, msg] of results) {
    if (st === 'PASS') pass++;
    console.log(`${st === 'PASS' ? '  ok  ' : ' FAIL '} ${name}${msg ? '  → ' + msg : ''}`);
  }
  console.log(`\n${pass}/${results.length} 通过`);
  try {
    fixtureSrv?.close();
    fixtureSrv?.closeAllConnections?.();
  } catch {
    /* noop */
  }
  process.exitCode = pass === results.length ? 0 : 1;
  app.exit(process.exitCode);
});
