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

const { probe, classifyHealth, isSelfUrl, isSafeExternal, isSafeReleaseUrl, APP_ID, PROTOCOL } = require('../electron/net-probe.cjs');

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

  /* ---------- 4b. 版本检查的 Release / 下载外链（P5） ----------
   *
   * 这一份比 isSafeExternal 更严：**https + GitHub 官方 host**。
   * 它守着的是「版本检查」那条路 —— 那里的 URL 来自外部响应
   * （GitHub API 的 html_url / browser_download_url），仓库被投毒或账号被接管时
   * 一个指向 evil.example 的「安装包」会被用户当成官方下载。
   *
   * 与后端 server/update-check.js 的同名实现必须一致（那一边有对拍断言）。 */
  const releaseAllow = [
    ['https://github.com/HYJ1817/pi-gui/releases/tag/v0.12.0', 'Release 页面'],
    ['https://github.com/HYJ1817/pi-gui/releases/download/v0.12.0/Pi-GUI-Setup-0.12.0.exe', '下载 asset'],
    ['https://api.github.com/repos/HYJ1817/pi-gui/releases/latest', 'API 地址'],
    ['https://objects.githubusercontent.com/x', '下载重定向落地域'],
    ['https://raw.githubusercontent.com/x', 'raw 域'],
  ];
  for (const [url, why] of releaseAllow) {
    check(`isSafeReleaseUrl 允许：${why}`, () => isSafeReleaseUrl(url) === true || url);
  }

  const releaseDeny = [
    ['https://evil.example/a.exe', '第三方 host'],
    ['https://github.com.evil.example/x', '后缀伪装'],
    ['https://evilgithubusercontent.com/x', '后缀伪装（缺那个点）'],
    ['https://user:pw@github.com/x', '带凭据的 URL'],
    ['http://github.com/x', 'http（非 https）'],
    ['javascript:alert(1)', 'javascript:'],
    ['file:///C:/Windows/win.ini', 'file:'],
    ['data:text/html,<script>alert(1)</script>', 'data:'],
    ['ftp://github.com/x', 'ftp:'],
    ['not a url', '非法 URL'],
  ];
  for (const [url, why] of releaseDeny) {
    check(`isSafeReleaseUrl 拒绝：${why}`, () => isSafeReleaseUrl(url) === false || url);
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

  /* ---------- 7. preload 桥（只为两个转发动作而存在） ----------
   *
   * 这个桥是渲染进程唯一能碰到主进程的地方，所以它的形状要钉死：
   * 只暴露一个入口对象、不暴露 ipcRenderer 本身、不碰任何凭据、
   * 也不自己判断路径与 URL（判定分别留在后端与主进程）。 */
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

  /* ---------- 8. 版本检查的外链桥（P5） ----------
   *
   * 「用系统浏览器打开 Release 链接」这条路的关键约束：**判定必须在主进程**。
   * 页面只能说「请打开这个 URL」，能不能打开由这里说了算 —— 所以 renderer
   * 里不该出现任何 shell / ipcRenderer 的痕迹。 */
  check('主进程注册了 pi-gui:open-external', () =>
    /ipcMain\.handle\('pi-gui:open-external'/.test(mainSrc) || '没有注册 open-external 处理器');
  check('openExternal 的判定用 isSafeReleaseUrl（比通用导航更严）', () =>
    /isSafeReleaseUrl\(target\)/.test(mainSrc) || '处理器里没有用 isSafeReleaseUrl 把关');
  check('open-external 处理器在开窗之前注册', () => {
    const reg = mainSrc.indexOf('installOpenExternalHandler();');
    const win = mainSrc.indexOf('createWindow();');
    return (reg > 0 && win > 0 && reg < win) || `register=${reg} createWindow=${win}`;
  });
  check('preload 暴露的是两个转发函数（openPath + openExternal）', () =>
    /openPath:\s*\(/.test(preloadCode) && /openExternal:\s*\(/.test(preloadCode) || '少了一个转发函数');
  check('preload 的 openExternal 只转发，不自己判断 URL', () =>
    !/isSafeReleaseUrl|isSafeExternal|github\.com/.test(preloadCode) || 'preload 里出现了 URL 判断逻辑');

  /* renderer 侧：**不许**碰 shell / ipcRenderer / 自己导航。
   * 结构性断言只看代码、不看注释（注释里解释「页面没有 shell 能力」是正常的）。 */
  const collectJs = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...collectJs(full));
      else if (e.name.endsWith('.js')) out.push(full);
    }
    return out;
  };
  const publicCode = collectJs(path.join(ROOT, 'public'))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  /* 只认 Electron 的 shell **API**，不认 `from './shell.js'` 这类模块路径 ——
   * 项目里恰好有一个叫 shell.js 的前端模块（外壳状态），用宽泛的
   * `\bshell\s*\.` 会把它的 import 全判成违规。 */
  check('renderer 里不调用 Electron shell API（页面没有 shell 权限）', () =>
    !/shell\.(openExternal|openPath|openItem|showItemInFolder|beep)\s*\(/.test(publicCode) ||
    '前端代码里出现了 shell API 调用');
  check('renderer 里不出现 ipcRenderer', () => !/ipcRenderer/.test(publicCode) || '前端代码里出现了 ipcRenderer');
  check('renderer 里不 require electron', () =>
    !/require\(\s*['"]electron['"]\s*\)/.test(publicCode) || '前端代码里 require 了 electron');
  check('前端打开外链只用 preload 的桥，不用 window.open', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'update.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    return (
      /piGuiDesktop/.test(src) && /bridge\.openExternal\(/.test(src) && !/window\.open\(/.test(src) ||
      '前端没有走 preload 的桥，或用了 window.open'
    );
  });
  /* 这条要问的是「前端有没有**发请求**给 GitHub」，不是「前端有没有提到 GitHub」。
   *
   * 原先写成裸子串扫描（`/api\.github\.com|github\.com\/HYJ1817/`），当时前端确实
   * 一个字都不该提 GitHub。P5 之后前端**合法地**持有 host 白名单
   * （`RELEASE_HOSTS` 里就有 `'api.github.com'`）—— 那是一份「允许打开哪些 host」
   * 的名单，不是请求。子串扫描会把名单本身判成违规。
   * 所以改成看**请求调用**，并额外挡住硬编码的 API URL。 */
  check('前端不直接访问 GitHub API（只打自己的后端）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'update.js'), 'utf8');
    if (/https:\/\/api\.github\.com\//.test(src)) return '前端里出现了硬编码的 GitHub API URL';
    const requests = [...src.matchAll(/\b(fetch|XMLHttpRequest|EventSource|sendBeacon)\s*\(([^\n]{0,160})/g)];
    const bad = requests.filter((m) => /github/i.test(m[2]));
    return bad.length === 0 || '前端里出现了指向 GitHub 的请求：' + bad.map((m) => m[0].slice(0, 70)).join(' | ');
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
