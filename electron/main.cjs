/* Pi GUI 的桌面外壳（Electron 主进程）。
 *
 * 这里刻意做得很薄：窗口、生命周期、进程管理，仅此而已。
 * 真正的服务逻辑一行都不重写 —— 直接复用已经过 16 项打包验证的 SEA 产物
 * （resources/server/pi-gui-server.exe），或者开发时用 ELECTRON_RUN_AS_NODE
 * 跑 server.js 源码。这样「桌面版」和「网页版」跑的是同一份后端，
 * 不会出现两套行为各自漂移。
 *
 * 用 .cjs 而非 .js：根 package.json 是 "type": "module"，
 * Electron 主进程用 CJS 最省事（避免 ESM 主进程的各种边角问题）。
 */
/* 启动前先排掉一个很坑的环境变量。
 *
 * 外部若设了 ELECTRON_RUN_AS_NODE=1，electron.exe 会退化成普通 node：
 * require('electron') 只拿得到 npm 包的路径字符串，于是 app 是 undefined，
 * 报错是「Cannot read properties of undefined (reading 'requestSingleInstanceLock')」
 * —— 完全看不出跟环境变量有关。CI、IDE 插件、部分开发工具会设它，
 * 所以这里摘掉变量把自己重新拉起，而不是让用户对着天书堆栈发愣。 */
if (process.env.ELECTRON_RUN_AS_NODE && process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, process.argv.slice(1), { env, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  return;
}

const { app, BrowserWindow, Menu, shell, dialog, screen, session, ipcMain } = require('electron');

if (!app || typeof app.whenReady !== 'function') {
  console.error(
    '这个文件必须由 Electron 启动，不能用 node 直接跑。\n' +
      '  开发时：npm run app\n' +
      '  打包后：双击 dist-app/…/Pi GUI.exe'
  );
  process.exit(1);
}
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

/* 端口探测与导航判定抽在 net-probe.cjs —— 那部分是纯逻辑，
 * 抽出来才能在没有 GUI 的环境下直接测（见 tests/electron-guard.cjs）。
 * 身份常量也从那里取，避免两处各写一份写歪。 */
const {
  getJson,
  probe: probeExistingServer,
  isSelfUrl: isSelfUrlOf,
  isSafeExternal,
  isSafeReleaseUrl,
} = require('./net-probe.cjs');

const PORT = Number(process.env.PORT || 7788);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, '..');

/* 本进程与后端之间的共享令牌。
 *
 * 每个实例现生成一份随机值，经环境变量交给后端，再由下面的
 * installTokenHeader() 统一给发往本后端的请求加头。
 * 这样做的关键收益：**token 从不进入渲染进程**。页面拿不到它，
 * 于是即便页面里有 XSS，也偷不走；同时也满足「不打印、不进 URL、不落盘」。 */
const AUTH_TOKEN = crypto.randomBytes(32).toString('hex');
const TOKEN_HEADER = 'X-Pi-Gui-Token';

let win = null;
let server = null;
let quitting = false;
const log = [];

/* ---------- 服务进程 ---------- */

/** 后端入口。
 *
 * 打包后：server.cjs 就在本文件同级（resources/app/），用 Electron 自带的 Node 跑它。
 *   —— 这样只带一份 Node 运行时。早先的版本是另带一个 Node SEA 单文件 exe，
 *      结果 Electron 和它各自装了一套 Node，白胖 93 MB。
 * 开发时：直接跑项目根目录的源码（改了即时生效）。
 *
 * 工作目录（= 后端进程自己的 cwd，**不是** pi 的 cwd）：
 *   打包后用用户数据目录。
 *   早先用 app.getPath('home')，而 server.js 那时又把 process.cwd() 当作
 *   默认项目 —— 两者叠加，等于「首次启动就落在用户主目录」，还会把主目录下的
 *   pi 历史会话整段恢复出来。现在 server.js 不再猜项目（没有就是没有），
 *   这里也就没必要再指向主目录；用 userData 至少保证任何相对路径写入都落在可写处。
 *   更不能用应用安装目录 —— Program Files 只读，而且会把 resources/app 当成用户项目。
 */
function serverCommand() {
  const bundled = path.join(__dirname, 'server.cjs');
  if (fs.existsSync(bundled)) {
    return { cmd: process.execPath, args: [bundled], cwd: app.getPath('userData') };
  }
  return { cmd: process.execPath, args: [path.join(ROOT, 'server.js')], cwd: ROOT };
}

/* 端口探测（isPortOpen / getJson / probeExistingServer）见 net-probe.cjs。
 * 这里只保留一个绑定到本实例端口的薄封装，调用点读起来更顺。 */
const probePort = (timeout) => probeExistingServer(ORIGIN, PORT, timeout);
const isSelfUrl = (url) => isSelfUrlOf(url, ORIGIN);

/** 复用之前还要确认「用得了」。
 *
 * 身份对得上 ≠ 令牌对得上：如果那个后端是**另一个 Pi GUI 实例**留下的
 * （上一份进程崩了、后端成了孤儿），它认的是那个实例的令牌，我们发什么都 401。
 * 这时候硬复用只会得到一个「界面能开、所有操作都失败」的壳子，
 * 所以要提前查出来并明确报错。 */
async function verifyAccess(timeout = 1500) {
  const r = await getJson(`${ORIGIN}/api/status`, timeout, { [TOKEN_HEADER]: AUTH_TOKEN });
  if (r.status === 401) return { ok: false, reason: 'token' };
  if (!r.ok) return { ok: false, reason: 'http', detail: r.detail || `HTTP ${r.status}` };
  return { ok: true };
}

async function waitForServer(ms = 25000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const probe = await probePort(500);
    if (probe.state === 'pi-gui') return true;
    // 端口被别的程序抢了，再等也不会变好
    if (probe.state === 'foreign-service') return false;
    if (server && server.exitCode !== null) return false; // 子进程已经挂了，再等也没用
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** 端口被别的程序占用时的统一提示。
 *  必须同时给出「关掉占用程序」和「换端口」两条出路，否则用户只能干瞪眼。 */
function foreignServiceMessage(detail) {
  return (
    `端口 ${PORT} 已被其他程序占用，请关闭占用程序或通过 PORT 环境变量修改 Pi GUI 端口。\n\n` +
    `（探测到该端口上有服务在监听，但它不是 Pi GUI：${detail || '身份不匹配'}）`
  );
}

async function ensureServer() {
  const probe = await probePort();

  if (probe.state === 'pi-gui') {
    const access = await verifyAccess();
    if (!access.ok) {
      const why =
        access.reason === 'token'
          ? '它的访问令牌与本实例不一致（通常意味着那是一个残留的 Pi GUI 后端进程）。'
          : `它没有正常响应：${access.detail}`;
      throw new Error(
        `${ORIGIN} 上已经有一个 Pi GUI 后端在运行，但本实例用不了它。\n\n` +
          `${why}\n\n` +
          `请先结束那个进程（或在任务管理器里结束残留的 electron / node 进程），` +
          `或者用 PORT 环境变量换一个端口再启动。`
      );
    }
    return { reused: true, version: probe.version };
  }

  if (probe.state === 'foreign-service') {
    throw new Error(foreignServiceMessage(probe.detail));
  }

  const { cmd, args, cwd } = serverCommand();
  server = spawn(cmd, args, {
    cwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1', // 让 electron.exe 以纯 Node 身份跑后端
      PI_GUI_OPEN: '0', // 桌面版自己有窗口，别再去开浏览器
      PORT: String(PORT),
      // 本实例的访问令牌。后端据此要求所有 /api/* 带令牌，
      // 而令牌只经由下面的 installTokenHeader() 注入到请求头里。
      PI_GUI_TOKEN: AUTH_TOKEN,
      // projects.json 和上传缓存要写到可写的地方。默认是应用安装目录，
      // 装在 Program Files 下会写不进去，所以指到用户数据目录。
      // 允许外部用 PI_GUI_DATA 覆盖 —— 自动化测试靠它把数据隔离到临时目录。
      PI_GUI_DATA: process.env.PI_GUI_DATA || app.getPath('userData'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const collect = (buf) => {
    log.push(buf.toString('utf8'));
    if (log.length > 200) log.shift();
  };
  server.stdout.on('data', collect);
  server.stderr.on('data', collect);
  server.on('exit', () => {
    server = null;
  });

  if (!(await waitForServer())) {
    // 起不来的原因可能不止一个，所以这里再探一次，把「被占了」和「自己崩了」分开说
    const again = await probePort(500);
    if (again.state === 'foreign-service') throw new Error(foreignServiceMessage(again.detail));
    throw new Error(`后端服务没能在 ${PORT} 端口起来。\n\n${log.join('').trim() || '（没有任何输出）'}`);
  }
  return { reused: false };
}

/** 给发往本后端的请求统一加上令牌头。
 *
 * 放在主进程（而不是页面里用 fetch 包装）的理由：渲染进程永远拿不到令牌，
 * 因此页面上的任何脚本 —— 包括被注入的 —— 都无法读取或伪造它。
 *
 * 注意这一层不再能省掉 preload 脚本了：preload.cjs 只为「用系统默认程序打开
 * 文件」这一个能力而存在（见 installOpenPathHandler）。令牌依然不进渲染进程 ——
 * preload 只转发**项目相对路径**，一个字节的凭据都不碰。 */
function installTokenHeader() {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${ORIGIN}/*`] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, [TOKEN_HEADER]: AUTH_TOKEN } });
  });
}

/** 处理渲染进程发来的「用系统默认程序打开这个文件」。
 *
 * ---------- 为什么这里不自己判断路径 ----------
 *
 * 「这个路径在不在当前项目里」的判定在 lib/git.js 的 resolveProjectPath 里：
 * realpath 解 junction / symlink、盘符大小写归一、`..` 与绝对路径拒绝，都实现了
 * 而且被测过。在主进程复制一份必然漂移，最后变成「两套规则里更松的那套说了算」。
 *
 * 所以主进程只做转发：把相对路径交给后端的 POST /api/git/open，由后端给出
 * **它认可的**绝对路径，主进程再交给 shell.openPath。即使页面被注入脚本，
 * 它能做到的也仅限于「请求打开一个后端认可的项目内文件」。
 *
 * 顺带一提，主进程发的 fetch 不会被 onBeforeSendHeaders 覆盖（那只作用于
 * 渲染进程的 session），所以这里要自己带令牌头。 */
function installOpenPathHandler() {
  ipcMain.handle('pi-gui:open-path', async (_e, relPath) => {
    if (typeof relPath !== 'string' || !relPath.trim()) {
      return { ok: false, error: '缺少文件路径' };
    }

    let body = null;
    let status = 0;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      try {
        const res = await fetch(`${ORIGIN}/api/git/open`, {
          method: 'POST',
          signal: ctl.signal,
          headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: AUTH_TOKEN },
          body: JSON.stringify({ path: relPath }),
        });
        status = res.status;
        body = await res.json().catch(() => null);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return { ok: false, error: '无法连接后端：' + err.message };
    }

    if (!body || body.ok !== true || typeof body.abs !== 'string') {
      return { ok: false, error: (body && body.error) || `后端未认可这个路径（HTTP ${status}）` };
    }

    // openPath 成功时返回空串，失败时返回错误描述（不会 reject）
    const err = await shell.openPath(body.abs);
    if (err) return { ok: false, error: err };
    return { ok: true, abs: body.abs };
  });
}

/** 处理渲染进程发来的「用系统浏览器打开这个链接」（版本检查的 Release / 下载）。
 *
 * ---------- 为什么判定放在这里，而不是页面里 ----------
 *
 * 页面只能说「请打开这个 URL」，**能不能打开由主进程决定**。这是本项目一贯的
 * 做法（和 openPath 那条同一个思路）：renderer 永远不持有 shell 能力，
 * 所以即便页面被注入脚本，它能做到的也只是「请求主进程打开一个
 * https + GitHub 官方 host 的地址」。
 *
 * 判据是 net-probe.cjs 的 isSafeReleaseUrl —— 比通用导航用的 isSafeExternal
 * 更严：**必须 https，且 host 在 GitHub 官方白名单里**。
 * 这样「用系统浏览器打开站外地址」这条路在桌面版里根本不成立。
 *
 * 注意这里**不查后端**：URL 本身就是判据，不需要向任何服务求证。
 * 另外刻意不做「先 GET 一下看看」这类预检 —— 那会给用户点开的链接
 * 平白多出一次请求，而且和浏览器实际发的请求并不是同一个。 */
function installOpenExternalHandler() {
  ipcMain.handle('pi-gui:open-external', async (_e, url) => {
    const target = typeof url === 'string' ? url.trim() : '';
    if (!target) return { ok: false, error: '缺少链接' };
    if (!isSafeReleaseUrl(target)) {
      /* 不回显被拒的 URL —— 它可能是页面被注入后塞进来的东西，
       * 没必要再让它出现在 toast / 日志里。 */
      return { ok: false, error: '已拒绝打开非 GitHub 官方链接' };
    }
    // openExternal 失败时 reject（不是返回错误串，与 openPath 相反）
    try {
      await shell.openExternal(target);
    } catch (err) {
      return { ok: false, error: '打开失败：' + (err && err.message ? err.message : String(err)) };
    }
    return { ok: true };
  });
}

/** 连同 pi 子进程一起收掉。只 kill 父进程会把 pi 留成孤儿。 */
function killServer() {
  if (!server || server.exitCode !== null) return;
  const pid = server.pid;
  try {
    server.kill();
  } catch {
    /* 已经没了就算了 */
  }
  if (process.platform === 'win32' && pid) {
    // /T 连子孙一起杀，/F 免确认 —— 退出流程里不能弹窗
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* noop */
    }
  }
  server = null;
}

/* ---------- 窗口 ---------- */

/* 窗口尺寸 / 位置 / 最大化状态记忆。
 *
 * 桌面应用的基本预期：关掉再开，窗口还是你上次摆的样子。不做的话每次都回到
 * 固定的 1320x880，用起来很别扭。
 *
 * 三个坑（前两个是常识，第三个是真花时间的，详见 contentDelta 那段）：
 *   - 最大化时 getBounds() 返回的是最大化后的框，直接存下来，下次「还原」就会
 *     得到一个占满屏幕的普通窗口。
 *   - 坐标可能落在已经不存在的显示器上（拔掉外接屏、改过分辨率），这时必须
 *     丢掉坐标只留尺寸，否则窗口会开在看不见的地方，用户以为程序没启动。
 *   - 「存下来的尺寸」和「构造时请求的尺寸」口径不同的话，窗口会每启动一次涨几像素。
 */
const DEFAULT_W = 1320;
const DEFAULT_H = 880;

/* 状态文件格式版本。
 *
 * v1 存外框尺寸（getNormalBounds）
 * v2 存客户区尺寸（getContentBounds）+ useContentSize
 * v3 存**请求值**（见 contentDelta 的说明）—— v1/v2 都会让窗口每启动一次涨 1~2px，
 *    必须丢弃，否则「升级后窗口还是慢慢变大」会让人以为没修。
 *
 * 这个字段还有个作用：以后再加字段时，旧文件会被安全忽略，而不是被半懂不懂地读进来。 */
const STATE_VERSION = 3;

/** 状态文件位置。
 *
 * 和后端的数据目录保持一致：都认 PI_GUI_DATA，缺省才落到 userData。
 * 早先这里写死 app.getPath('userData')，结果是自动化测试没法隔离 ——
 * 它会去改用户真实的窗口状态，而且测试自己也找不到写出来的文件。 */
function stateFile() {
  return path.join(process.env.PI_GUI_DATA || app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return null; // 首次启动，或文件损坏 —— 用默认尺寸
  }
  if (s?.v !== STATE_VERSION) return null; // 旧格式（见 STATE_VERSION 的说明）
  if (!Number.isFinite(s?.width) || !Number.isFinite(s?.height)) return null;
  if (s.width < 960 || s.height < 620) return null; // 小于最小尺寸就别照搬

  if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return s.x < a.x + a.width && s.x + s.width > a.x && s.y < a.y + a.height && s.y + s.height > a.y;
    });
    if (!onScreen) {
      delete s.x;
      delete s.y;
    }
  }
  return s;
}

let stateTimer = null;

/* 「请求的尺寸」与「实际得到的客户区尺寸」之间的偏差。
 *
 * ---------- 这是本项目最费劲的一个坑，完整记下来 ----------
 *
 * 症状：关掉再开，窗口比上次大一点。不报错，只是用着用着变大了。
 *
 * 实测（本机 dpr = 1.5，即 150% 缩放；Electron 44 + 自绘标题栏）：
 *     请求 1000x660 → 实际客户区 1001x663   （偏差 +1/+3）
 *     请求 1001x663 → 实际客户区 1004x663   （偏差 +3/ 0）
 *     请求 1004x663 → 实际客户区 1005x663   （偏差 +1/ 0）
 *     请求 1005x663 → 实际客户区 1008x663   （偏差 +3/ 0）
 *   —— 偏差是 1~3px，而且是**请求值的函数**（Windows 要把窗口矩形吸附到物理像素，
 *      150% 下 1 DIP = 1.5 物理像素，取整方向随值变化）。
 *
 * 为什么前两版都错了：
 *   v1 存 getNormalBounds()（外框），构造时 width/height 也按外框解释 —— 看着自洽，
 *      但「存的时候从客户区往上取整」和「建的时候从外框往下取整」不是同一次取整，
 *      每次都差 1~2px。
 *   v2 改成存 getContentBounds() + useContentSize，以为「存取同源」就行 —— 没用。
 *      因为问题不在存哪个字段，而在**请求值和实际值本来就不相等**：
 *      存量到的值，下次拿它当请求值，就会被再加一次偏差，于是每开一次涨 1~2px。
 *
 * 正确做法：存**请求值**，而不是量到的值。同样的请求必然得到同样的窗口 —— 稳定。
 * 用户拖动窗口后，量到的客户区减去这个偏差，就还原成「等效请求值」再存。
 * 偏差在建窗口那一刻量一次即可（窗口还没被人动过）。
 *
 * 这个修法的好处是不需要知道 Windows 为什么这么取整：偏差测出来取反就行，
 * 换台机器、换个缩放比例自动适应。 */
let contentDelta = { w: 0, h: 0 };

/* 最后一次已知的「正常尺寸」（已经换算成请求值的口径）。
 *
 * 为什么不只靠 close 事件保存 —— 也是实测踩到的：
 * 渲染进程里调 window.close() 时，Electron 是**直接 destroy 窗口**的，只发 closed、
 * 不发 close（日志里能看到 closed / window-all-closed / before-quit，唯独没有 close）。
 * 用户点原生 X 走的是 WM_CLOSE，会正常发 close，所以这条路径平时看不出问题；
 * 但只要关闭来源换成脚本、快捷键、系统关机，挂在 close 上的逻辑就全部静默失效。
 *
 * 所以：每次 resize / move / maximize 都把 bounds 记进内存（同步、极便宜），
 * 退出时即使窗口已经 destroyed 也能写出来。 */
let lastBounds = null;

/** 量一次「请求 → 实际」的偏差。必须在窗口刚建好、还没被用户动过的时候调。 */
function measureContentDelta(requested) {
  if (!win || win.isDestroyed()) return;
  try {
    const c = win.getContentBounds();
    contentDelta = { w: c.width - requested.width, h: c.height - requested.height };
    if (process.env.PI_GUI_DEBUG) {
      console.log(
        '[Pi GUI][debug] 请求 ' +
          requested.width +
          'x' +
          requested.height +
          ' → 实际客户区 ' +
          c.width +
          'x' +
          c.height +
          '，偏差 ' +
          contentDelta.w +
          '/' +
          contentDelta.h
      );
    }
  } catch {
    /* 量不到就用 0 偏差 —— 顶多退回 v2 的行为，不会更糟 */
  }
}

function rememberBounds() {
  if (!win || win.isDestroyed()) return; // 窗口没了就保留上一次的记录
  try {
    // 最大化 / 全屏 / 最小化时的 bounds 反映的不是「正常尺寸」，别拿它覆盖记录，
    // 只把最大化标记更新一下 —— 否则下次「还原」会得到一个占满屏幕的普通窗口。
    if (win.isMinimized() || win.isMaximized() || win.isFullScreen()) {
      if (lastBounds) lastBounds.maximized = win.isMaximized();
      return;
    }
    const f = win.getBounds(); // x/y 用外框坐标：构造参数的 x/y 就是外框原点，能原样往返
    const c = win.getContentBounds(); // 尺寸用客户区，再减掉偏差还原成请求值
    lastBounds = {
      x: f.x,
      y: f.y,
      width: c.width - contentDelta.w,
      height: c.height - contentDelta.h,
      maximized: false,
    };
  } catch {
    /* 窗口正在销毁，这一瞬间拿不到就算了 */
  }
}

function saveWindowState() {
  clearTimeout(stateTimer);
  stateTimer = null;
  rememberBounds(); // 窗口还在就取最新值，不在就沿用记录
  if (!lastBounds) return; // 从来没量到过（窗口没建起来），没得写
  try {
    const f = stateFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ v: STATE_VERSION, ...lastBounds }, null, 2) + '\n', 'utf8');
  } catch (e) {
    // 别静默吞掉：窗口记不住尺寸是「感觉不对但查不出原因」的典型症状
    console.error('[Pi GUI] 窗口状态写盘失败：' + e.message);
  }
}

/** 拖动 / 缩放时别每帧写盘，停下来再写。
 *  内存里的记录要**立刻**更新（很便宜），只有落盘才延后 —— 否则「拖完马上关窗」
 *  就丢了最后那一下。 */
function scheduleSaveWindowState() {
  rememberBounds();
  clearTimeout(stateTimer);
  stateTimer = setTimeout(saveWindowState, 400);
}

/* ---------- 导航与链接的收口 ---------- */

/* isSelfUrl / isSafeExternal 的判定实现在 net-probe.cjs（纯逻辑，可单测）。
 * 这里只负责把本实例的 ORIGIN 绑进去。 */

/** 把「窗口只能待在自家页面里」这条规则钉死。
 *
 * 挂在 app 的 web-contents-created 上而不是 win.webContents 上：
 * 前者对**每一个** webContents 生效，以后万一多出别的窗口/预览面板，
 * 不用记得再去补一遍 —— 漏补一次就等于开了一个导航缺口。
 *
 * 三条路径都要堵：
 *   - window.open / target=_blank  → setWindowOpenHandler 直接 deny
 *   - window.location / <a href>   → will-navigate 拦下
 *   - 服务端 30x 跳转              → will-redirect 拦下（它不走 will-navigate） */
function hardenWebContents(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  const guard = (e, url) => {
    if (isSelfUrl(url)) return; // 自己的页面随便跳
    e.preventDefault();
    if (isSafeExternal(url)) shell.openExternal(url);
  };

  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
}

function createWindow() {
  // 打包后 exe 自己就带着图标，这个参数只在开发时有用
  const iconFile = path.join(ROOT, 'build', 'icon.ico');
  const saved = loadWindowState();

  win = new BrowserWindow({
    /* width/height 走 useContentSize，即「客户区尺寸」而不是外框尺寸。
     *
     * 这不是随手加的：状态文件里存的也是客户区尺寸（见 rememberBounds 的说明）。
     * 两边必须同源，否则 150% 缩放下的物理像素吸附会让窗口每启动一次涨 1~2px。 */
    width: saved?.width ?? DEFAULT_W,
    height: saved?.height ?? DEFAULT_H,
    useContentSize: true,
    ...(Number.isFinite(saved?.x) && Number.isFinite(saved?.y) ? { x: saved.x, y: saved.y } : {}),
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0d0d0d', // 和页面底色一致，避免加载时闪白
    title: 'Pi GUI',
    ...(fs.existsSync(iconFile) ? { icon: iconFile } : {}),
    autoHideMenuBar: true, // 藏掉 Electron 默认的 File/Edit/View 菜单，按 Alt 仍可唤出
    /* 自绘标题栏。
     *
     * 用系统默认标题栏的话，浅色主题下会在深色界面顶上压一条亮灰横条，
     * 整个窗口立刻像「浏览器套壳」—— 这正是用户一开始就指出的问题。
     * titleBarStyle:'hidden' 把标题栏并进客户区，titleBarOverlay 再把原生的
     * 最小化 / 最大化 / 关闭按钮画回来（可指定底色），既保住系统交互又能融进深色。
     *
     * 代价：顶部那 46px 得自己划拖拽区（见 styles.css 的 -webkit-app-region），
     * 右侧还要给原生按钮让位，否则会盖住顶栏最右的几个图标。
     * 高度取 46 是为了和 .rail-head / .stage-head 的行高对齐。
     * 颜色直接抄样式表里的值：底色 #0d0d0d 是会话区背景（--main，按钮正压在这上面），
     * 符号 #9b9b9b 是顶栏图标的颜色（--t2）。用别的值会在顶栏右上角露出色块。 */
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d0d0d', symbolColor: '#9b9b9b', height: 46 },
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      /* 只为「用系统默认程序打开文件」与「用系统浏览器打开 Release 链接」
       * 挂一个桥（见 preload.cjs）。contextIsolation 保持开启 —— 桥经
       * contextBridge 暴露，页面拿不到 ipcRenderer 本身，也拿不到任何凭据。 */
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  win.once('ready-to-show', () => {
    /* 先量偏差，再最大化 —— 顺序不能反：最大化之后 getContentBounds() 给的是
       最大化后的客户区，量出来的偏差会大得离谱，之后每次保存都会被减掉这么多。 */
    measureContentDelta({ width: saved?.width ?? DEFAULT_W, height: saved?.height ?? DEFAULT_H });
    if (saved?.maximized) win.maximize();
    win.show();
  });
  win.loadURL(ORIGIN);

  win.on('resize', scheduleSaveWindowState);
  win.on('move', scheduleSaveWindowState);
  win.on('maximize', scheduleSaveWindowState);
  win.on('unmaximize', scheduleSaveWindowState);
  /* 正常关闭（点 X、WM_CLOSE）时立刻落盘，不等防抖。
     注意这只是「快一步」，不是唯一保障 —— 窗口被 destroy 时这个事件不会发，
     真正兜底的是下面 before-quit / window-all-closed 那两处。 */
  win.on('close', saveWindowState);

  /* 渲染进程挂了必须说出来。
   *
   * 这是本轮实测踩到的一个真实缺陷形态：受限环境里 Chromium 沙箱起不来，
   * 渲染进程一启动就被杀。此时：
   *   - ready-to-show 永不触发 → 窗口一直 show:false → 用户什么也看不见
   *   - 没有异常弹窗、没有日志（除非加 --enable-logging）
   * 表现就是「双击了，但什么都没发生」，最难排查的那种失败。
   *
   * 所以这里把原因显式抛给用户。reason 常见值：
   *   crashed / oom / killed / launch-failed / integrity-failure
   */
  win.webContents.on('render-process-gone', (_e, details) => {
    const reason = details?.reason || 'unknown';
    const exitCode = details?.exitCode ?? '?';
    console.error(`[Pi GUI] 渲染进程退出：reason=${reason} exitCode=${exitCode}`);

    // 崩溃可能发生在首帧之前，这时窗口还藏着，得先让它可见再弹窗
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();

    dialog.showErrorBox(
      'Pi GUI 界面进程异常退出',
      `界面渲染进程退出了（reason=${reason}, exitCode=${exitCode}）。\n\n` +
        '常见原因：\n' +
        '  • 系统资源不足（内存被占满时会触发 oom）\n' +
        '  • 运行环境限制了 Chromium 沙箱 —— 这类环境（部分容器 / 受限权限的\n' +
        '    自动化环境）可以用「--no-sandbox」启动来绕过，但普通桌面环境\n' +
        '    不建议这么做，关掉沙箱会降低隔离性。\n\n' +
        '重开一次通常能恢复；若反复出现，请带上这行 reason 反馈。'
    );
  });

  // 页面加载失败（后端没起来、端口被占等）。同样别让它静默。
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    console.error(`[Pi GUI] 页面加载失败：${code} ${desc} ${url}`);
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
    dialog.showErrorBox(
      'Pi GUI 打不开界面',
      `加载 ${url} 失败：${desc}（${code}）\n\n` +
        `内置后端应该在 ${ORIGIN} 上。如果这个端口被别的程序占了，\n` +
        '可以设环境变量 PORT 换一个端口再启动。'
    );
  });

  // 站外链接与导航的收口见下面的 hardenWebContents()（挂在 app 级事件上）

  /* 应用菜单被藏掉了，快捷键就得自己接。
   *
   * 注意 before-input-event 是在**页面拿到按键之前**触发的，所以这里拦下的
   * 组合键不会漏到输入框里；没拦的一律放行，别影响正常打字。
   *
   * 缩放是桌面应用的常规预期（也是无障碍需要）。Ctrl+Q 是自绘标题栏的安全网 ——
   * 万一原生关闭按钮因为环境问题没画出来，用户总还有路退出。 */
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key;
    const lower = key.toLowerCase();

    if (key === 'F12' || (input.control && input.shift && lower === 'i')) {
      win.webContents.toggleDevTools();
      return e.preventDefault();
    }

    if (input.control && !input.alt && !input.shift) {
      if (lower === 'q') {
        app.quit();
        return e.preventDefault();
      }
      if (key === '0') {
        win.webContents.setZoomLevel(0);
        return e.preventDefault();
      }
      if (key === '=' || key === '+') {
        win.webContents.setZoomLevel(Math.min(win.webContents.getZoomLevel() + 0.5, 3));
        return e.preventDefault();
      }
      if (key === '-' || key === '_') {
        win.webContents.setZoomLevel(Math.max(win.webContents.getZoomLevel() - 0.5, -3));
        return e.preventDefault();
      }
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

/* ---------- 生命周期 ---------- */

// 第二次双击：聚焦已有窗口，而不是开第二个实例
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.pigui.desktop'); // 让任务栏正确归组

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  /* 所有 webContents 的导航规则统一在这里钉死（见 hardenWebContents 的说明）。
   * 放在 app 级而不是逐个窗口上，是为了以后新增窗口时不会漏掉。 */
  app.on('web-contents-created', (_e, wc) => hardenWebContents(wc));

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // 令牌头的注入必须赶在窗口发第一个请求之前装好
    installTokenHeader();
    // 「用系统默认程序打开文件」与「用系统浏览器打开链接」两个 IPC ——
    // 必须在 createWindow 之前注册，否则页面首帧就调用的话会拿到
    // "No handler registered"。
    installOpenPathHandler();
    installOpenExternalHandler();
    // 用户数据目录先建出来 —— 后端启动就要往里写 projects.json
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
    } catch {
      /* 建不出来就让后端自己报错，别在这里拦 */
    }
    try {
      await ensureServer();
    } catch (err) {
      /* 注意：走到这里绝不能再去 loadURL。
       * 端口被别的程序占用时把窗口指向那个端口，用户会看到一个陌生的页面
       * 加一堆查不出原因的 API 报错 —— 那比直接报错难排查得多。 */
      dialog.showErrorBox('Pi GUI 启动失败', String(err.message || err));
      app.exit(1);
      return;
    }
    createWindow();
  });

  // 关掉窗口就是退出程序 —— 桌面应用不该留个后台进程偷偷活着
  app.on('window-all-closed', () => {
    /* 兜底保存一次。
     *
     * 走到这里时 win 通常已经 destroyed，但 rememberBounds() 早就把最后一份
     * bounds 留在内存里了，所以照样写得出来。这一步覆盖的正是「窗口被 destroy、
     * close 事件不发」的那些关闭路径 —— 也就是实测发现 window.close() 会走的那条。 */
    saveWindowState();
    app.quit();
  });

  app.on('before-quit', () => {
    // 再兜一层：Ctrl+Q、系统关机等直接触发 quit 的情况，窗口可能还活着也可能已经没了
    saveWindowState();
    quitting = true;
    killServer();
  });

  process.on('exit', () => {
    if (!quitting) killServer();
  });
}
