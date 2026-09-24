/* Electron 侧安全边界的可测部分。
 *
 * 背景：main.cjs 一 require('electron') 就没法在普通 Node 下跑，于是它最要紧的
 * 两处判断一直**没有测试**，只能靠人肉 review：
 *   1. 端口上的服务到底是不是自己人（判错 = 把陌生程序的页面加载进主窗口）
 *   2. 一个链接能不能在应用里打开（判错 = 站外页面顶掉应用界面 / 执行危险 scheme）
 * 这两处已被抽到 electron/net-probe.cjs（纯逻辑、不依赖 electron），
 * 所以这里可以拿**真实的 HTTP 服务**去验，而不是只对着源码做字符串检查。
 *
 * 剩下确实只能在 GUI 里发生的事（窗口导航事件），用少量结构性断言兜住意图。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { probe, classifyHealth, isSelfUrl, isSafeExternal, APP_ID, PROTOCOL } = require('../electron/net-probe.cjs');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.GUARD_PORT || 7796);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), 'pi-gui-guard-data');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  const ok = typeof cond === 'function' ? cond() : cond;
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok && typeof ok === 'string' ? '  → ' + ok : extra ? '  → ' + extra : ''));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个「冒充占用端口的陌生服务」。body 由调用方决定，用来模拟各种身份。 */
function startFakeServer(body, { status = 200, contentType = 'application/json' } = {}) {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': contentType });
      res.end(typeof body === 'function' ? body() : body);
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

function stopFakeServer(srv) {
  return new Promise((resolve) => {
    try {
      srv.close(() => resolve());
      srv.closeAllConnections?.();
    } catch {
      resolve();
    }
    setTimeout(resolve, 500);
  });
}

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  /* ---------- 1. 端口没人听 ---------- */
  {
    const r = await probe(ORIGIN, PORT, 500);
    check('端口空着 → not-running', () => r.state === 'not-running' || `state=${r.state}`);
  }

  /* ---------- 2. 端口被陌生服务占用 ---------- */

  // 2a. 返回了合法 JSON，但 app 不是 pi-gui
  let fake = await startFakeServer(JSON.stringify({ ok: true, app: 'some-other-app', protocol: 1 }));
  {
    const r = await probe(ORIGIN, PORT, 900);
    check('陌生 JSON 服务 → foreign-service', () => r.state === 'foreign-service' || `state=${r.state}`);
    check('foreign-service 会带出可读的判据', () => /app=/.test(r.detail || '') || `detail=${r.detail}`);
  }
  await stopFakeServer(fake);

  // 2b. 根本不是 JSON（典型：一个随便什么 web 服务）
  fake = await startFakeServer('<!doctype html><title>hello</title>', { contentType: 'text/html' });
  {
    const r = await probe(ORIGIN, PORT, 900);
    check('返回 HTML 的服务 → foreign-service', () => r.state === 'foreign-service' || `state=${r.state}`);
  }
  await stopFakeServer(fake);

  // 2c. 声称是 pi-gui，但协议版本对不上（旧版后端）
  fake = await startFakeServer(JSON.stringify({ ok: true, app: APP_ID, protocol: PROTOCOL + 1 }));
  {
    const r = await probe(ORIGIN, PORT, 900);
    check('协议版本不符 → foreign-service（不复用旧后端）', () => r.state === 'foreign-service' || `state=${r.state}`);
    check('协议不符时 detail 指出 protocol', () => /protocol=/.test(r.detail || '') || `detail=${r.detail}`);
  }
  await stopFakeServer(fake);

  // 2d. 404（端口上有个服务，但没有 /api/health）
  fake = await startFakeServer('{"error":"not found"}', { status: 404 });
  {
    const r = await probe(ORIGIN, PORT, 900);
    check('404 的陌生服务 → foreign-service', () => r.state === 'foreign-service' || `state=${r.state}`);
  }
  await stopFakeServer(fake);

  /* ---------- 3. 端口上是真正的 pi-gui 后端 ---------- */
  const TOKEN = 'a'.repeat(64);
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PI_GUI_OPEN: '0', PI_GUI_DATA: DATA, PI_CWD: '', PI_GUI_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  srv.stdout.on('data', (d) => (out += d));
  srv.stderr.on('data', (d) => (out += d));

  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await sleep(400);
      try {
        const r = await fetch(ORIGIN + '/api/health');
        if (r.ok) {
          up = true;
          break;
        }
      } catch {
        /* 还没起来 */
      }
    }
    check('本应用后端能起来', () => up || out.slice(0, 300));

    const r = await probe(ORIGIN, PORT, 900);
    check('真正的 pi-gui 后端 → pi-gui（可以复用）', () => r.state === 'pi-gui' || `state=${r.state} detail=${r.detail}`);
    check('复用时会带出版本号', () => typeof r.version === 'string' && r.version.length > 0 || `version=${r.version}`);
    check('复用时会带出协议版本', () => r.protocol === PROTOCOL || `protocol=${r.protocol}`);
  } finally {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(srv.pid), '/T', '/F'], { stdio: 'ignore' });
      else srv.kill();
    } catch {
      /* 已退出 */
    }
  }

  /* ---------- 4. URL 判定（纯函数） ---------- */
  const selfCases = [
    [`${ORIGIN}`, true, '根地址'],
    [`${ORIGIN}/`, true, '带斜杠'],
    [`${ORIGIN}/index.html?a=1#b`, true, '带路径与查询'],
    [`http://127.0.0.1:${PORT + 1}/`, false, '端口不同'],
    [`http://localhost:${PORT}/`, false, '主机名不同（我们只认 127.0.0.1）'],
    [`http://127.0.0.1:${PORT}.evil.example/`, false, '前缀伪装（startsWith 会误判）'],
    [`https://127.0.0.1:${PORT}/`, false, 'scheme 不同'],
    ['file:///C:/Windows/win.ini', false, 'file:'],
    ['javascript:alert(1)', false, 'javascript:'],
    ['data:text/html,<script>alert(1)</script>', false, 'data:'],
    ['about:blank', false, 'about:'],
    ['not a url at all', false, '根本不是 URL'],
  ];
  for (const [url, want, why] of selfCases) {
    check(`isSelfUrl(${why}) = ${want}`, () => isSelfUrl(url, ORIGIN) === want || `得到 ${isSelfUrl(url, ORIGIN)}`);
  }

  const extCases = [
    ['https://example.com/a', true, 'https'],
    ['http://example.com', true, 'http'],
    ['HTTPS://EXAMPLE.COM', true, '大小写不敏感'],
    ['javascript:alert(1)', false, 'javascript:'],
    ['file:///etc/passwd', false, 'file:'],
    ['data:text/html,x', false, 'data:'],
    ['vbscript:msgbox(1)', false, 'vbscript:'],
    ['mailto:a@b.com', false, 'mailto（不交给系统浏览器）'],
    ['chrome://settings', false, 'chrome:'],
    ['not a url', false, '非法 URL'],
  ];
  for (const [url, want, why] of extCases) {
    check(`isSafeExternal(${why}) = ${want}`, () => isSafeExternal(url) === want || `得到 ${isSafeExternal(url)}`);
  }

  /* ---------- 5. classifyHealth 的边界 ---------- */
  check('classifyHealth 容忍 undefined', () => classifyHealth(undefined).state === 'foreign-service');
  check('classifyHealth 容忍 body 为 null', () => classifyHealth({ ok: true, status: 200, body: null }).state === 'foreign-service');

  /* ---------- 6. 结构性断言：GUI 里才发生的事 ---------- */
  const mainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf8');
  check('主窗口只 loadURL 一次（启动失败分支不得再加载页面）', () => {
    const n = (mainSrc.match(/\.loadURL\(/g) || []).length;
    return n === 1 || `出现 ${n} 次 —— 端口被占时可能仍会把窗口指过去`;
  });
  check('启动失败时弹错并退出，而不是继续开窗', () =>
    /catch\s*\(err\)\s*\{[\s\S]*?showErrorBox[\s\S]*?app\.exit\(1\)[\s\S]*?return;/.test(mainSrc) ||
    '没看到「showErrorBox + app.exit(1) + return」的组合'
  );
  check('同时拦 will-navigate 与 will-redirect', () =>
    /on\('will-navigate'/.test(mainSrc) && /on\('will-redirect'/.test(mainSrc) || '少挂了一个导航事件'
  );
  check('window.open 一律 deny', () =>
    /setWindowOpenHandler\([\s\S]*?action:\s*'deny'/.test(mainSrc) || 'setWindowOpenHandler 没有 deny'
  );
  check('导航规则挂在 app 级（所有 webContents 都覆盖）', () =>
    /app\.on\('web-contents-created'/.test(mainSrc) || '没挂 web-contents-created'
  );
  check('令牌经请求头注入，不进渲染进程', () => {
    if (!/onBeforeSendHeaders/.test(mainSrc)) return '没有 onBeforeSendHeaders';
    if (!/PI_GUI_TOKEN:\s*AUTH_TOKEN/.test(mainSrc)) return '没有把令牌经环境变量交给后端';
    return true;
  });

  /* ---------- 7. preload 桥（只为「用系统默认程序打开文件」而存在） ----------
   *
   * 这个桥是渲染进程唯一能碰到主进程的地方，所以它的形状要钉死：
   * 只暴露一个函数、不暴露 ipcRenderer 本身、不碰任何凭据。 */
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.cjs'), 'utf8');
  /* 结构性断言必须只看**代码**，不看注释 —— 否则一句解释性的
   * 「校验留在后端，比如 ../ 和 realpath」就会把断言判成失败。
   * 这类误报很坑：它逼着人把注释写含糊，反而降低了可读性。 */
  const preloadCode = preloadSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  check('主窗口挂了 preload', () => /preload:\s*path\.join\(__dirname,\s*'preload\.cjs'\)/.test(mainSrc) || 'webPreferences 里没有 preload');
  check('contextIsolation 仍然开启', () => /contextIsolation:\s*true/.test(mainSrc) || 'contextIsolation 被关掉了');
  check('nodeIntegration 仍然关闭', () => /nodeIntegration:\s*false/.test(mainSrc) || 'nodeIntegration 被打开了');
  check('preload 只经 contextBridge 暴露一个入口', () => {
    const n = (preloadCode.match(/exposeInMainWorld\(/g) || []).length;
    return n === 1 || `exposeInMainWorld 出现 ${n} 次`;
  });
  check('preload 不把 ipcRenderer 整个暴露出去', () => !/exposeInMainWorld\([\s\S]*?\bipcRenderer\b\s*[,}]/.test(preloadCode) || '把 ipcRenderer 暴露了');
  check('preload 不接触令牌', () => !/TOKEN/.test(preloadCode) || 'preload 里出现了令牌');
  check('preload 不做路径判断（校验留在后端）', () => !/isAbsolute|realpath|path\.resolve|\.\.\//.test(preloadCode) || 'preload 里出现了路径校验');
  check('IPC 处理器只转发给后端，不自己判断路径', () => {
    if (!/ipcMain\.handle\('pi-gui:open-path'/.test(mainSrc)) return '没有注册 open-path 处理器';
    if (!/\/api\/git\/open/.test(mainSrc)) return '没有转发到后端的 /api/git/open';
    return true;
  });
  check('IPC 处理器在开窗之前注册', () => {
    const reg = mainSrc.indexOf('installOpenPathHandler();');
    const win = mainSrc.indexOf('createWindow();');
    return (reg > 0 && win > 0 && reg < win) || `register=${reg} createWindow=${win}`;
  });

  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 800);
}

main().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
