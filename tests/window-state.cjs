/* 窗口状态记忆验收：关掉再开，窗口应当回到原样，而且**不能每次启动都变大一点**。
 *
 * 为什么值得单独测：
 *   1. 「保存的尺寸」和「new BrowserWindow 的 width/height」未必是同一套口径。
 *      只要不一致，窗口每启动一次就涨几像素 —— 不报错，只是「用着用着变大了」，
 *      非常难查。这个脚本就是为抓它写的，而且**真的抓到了**（见下）。
 *   2. 最大化时 getBounds() 返回的是最大化后的框，直接存会让下次「还原」变成占满屏。
 *   3. 坐标可能落在已经不存在的显示器上（拔掉外接屏），照搬就把窗口开到看不见的地方。
 *   4. 关闭路径不止一条：点 X 走 WM_CLOSE（发 close 事件），脚本里 window.close() 是
 *      直接 destroy（**不发** close）。挂在 close 上的保存逻辑会在某些路径下静默失效。
 *
 * ---------- 这个脚本抓到过的真 bug（别再改回去） ----------
 *
 * 症状：关掉再开，窗口比上次大一点。实测连开 4 次 1000 → 1008（宽）。
 *
 * 根因：本机 dpr = 1.5（150% 缩放）。Windows 要把窗口矩形吸附到物理像素，
 *   于是「请求的尺寸」和「实际得到的客户区尺寸」不相等，偏差 1~3px，
 *   而且是**请求值的函数**：
 *       请求 1000x660 → 实际客户区 1001x663
 *       请求 1001x663 → 实际客户区 1004x663
 *       请求 1004x663 → 实际客户区 1005x663
 *   存量到的客户区、下次拿它当请求值，就会被再加一次偏差 → 每开一次涨 1~2px。
 *
 * 正确做法（已实现在 main.cjs）：存**请求值**而不是量到的值。同样的请求必然得到
 *   同样的窗口，稳定；用户拖动后量到的客户区减去启动时测出的偏差，就还原成请求值。
 *
 * ---------- 关于断言里的两档容差 ----------
 *
 *   TOL_LOOSE（8px）—— 「重开后 vs 关闭前」：中间隔了一次偏差换算，留点余量；
 *   TOL_EXACT（1px）—— 「重开后 vs 再重开后」：**这才是漂移判据**。同样输入必须
 *                       一模一样，否则就是累积漂移，必挂。
 *
 * 排查这类问题时，光看「重开后 vs 关闭前」会误判成「有漂移」而去找错方向。
 *
 * 配套诊断脚本：tests/diag-content.cjs（把「请求 → 实际」的链条整条打出来）。
 * 注意诊断时**必须用真实关闭路径**（taskkill 不带 /F），否则状态文件根本不会被重写，
 * 会看到「完全不漂」的假象 —— 这个坑我踩了两次。
 *
 * 需要真实桌面会话。用法：npm run test:window
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist-app', 'Pi GUI-win32-x64', 'Pi GUI.exe');
const APP_PORT = Number(process.env.E2E_PORT || 7788);
const CDP_PORT = Number(process.env.CDP_PORT || 9224);
const APP = `http://127.0.0.1:${APP_PORT}/`;
const WORK = path.join(os.tmpdir(), 'pi-gui-ws-work');
const DATA = path.join(os.tmpdir(), 'pi-gui-ws-data');
const STATE = path.join(DATA, 'window-state.json');
const TOL_LOOSE = 8; // 跨一次「存盘 → 重建」的往返：含 DPI 取整，给宽一点
const TOL_EXACT = 1; // 同样输入下的重复开关：必须一模一样

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rmQuiet = (p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* 被占用就留着 */
  }
};

/** 这个 pid 还在不在。
 *
 * 用 tasklist 而不是固定 sleep：上一个实例没退干净就起下一个时，新实例 bind 不上
 * CDP 端口，日志里只有一行 WSAEADDRINUSE，表现却是「页面一直没加载完」——
 * 看起来像应用起不来，其实是测试自己没等。
 *
 * 注意别用「输出里有没有数字」判断 —— 中文系统的空结果是
 * 「信息: 没有运行的任务匹配指定标准。」，里面没有数字，但换成别的区域设置就未必。
 * 稳妥做法是看输出里有没有出现这个 pid 本身。 */
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

async function waitProcessGone(pid, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await pidAlive(pid))) return true;
    await sleep(250);
  }
  return false;
}

/** 等 CDP 端口彻底空出来 —— 下一个实例要靠它。 */
async function waitCdpFree(ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    } catch {
      return true;
    }
    await sleep(300);
  }
  return false;
}

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push([r === true || r === undefined ? 'PASS' : 'FAIL', name, r === true || r === undefined ? '' : String(r)]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
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
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 160));
    return r.result?.result?.value;
  };
  return { ws, ready, send, evalJs };
}

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
  const kill = () => {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* noop */
    }
  };
  return { proc, kill, log };
}

/** 起一个实例、等页面就绪、把视口尺寸读出来。
 *  返回 {cdp, inner, close}；close() 走 window.close() 触发正常关闭（会保存状态）。 */
async function boot(label) {
  const inst = launch();
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
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.url.includes(String(APP_PORT)));
      if (p?.title) {
        page = p;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  if (!page) {
    inst.kill();
    throw new Error(`${label}: 页面一直没加载完。日志：\n` + inst.log.join('').slice(-600));
  }
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  const inner = JSON.parse(await cdp.evalJs('JSON.stringify([window.innerWidth, window.innerHeight])'));

  const close = async () => {
    /* 必须走「正常关闭」才测得到保存逻辑 —— 主进程是在 win.on('close') 里写盘的，
       taskkill /F 直接砍进程不会触发它。

       顺序（从最接近真实用户操作到最粗暴）：
         1. taskkill 不带 /F —— 它给窗口发 WM_CLOSE，就是用户点原生 X 按钮那条路。
            实测这条会正常触发 BrowserWindow 的 close 事件。
         2. 页面里的 window.close() —— 实测这条**不会**触发 close（Electron 直接
            destroy 窗口，只发 closed）。留着当第二选择，顺便保证「窗口被 destroy
            的路径也不丢状态」这个兜底逻辑一直有人测。
         3. CDP 的 Browser.close。
         4. 强杀。
       前三条都不行就把「没走正常关闭」记下来，免得把「保存没触发」误判成「保存写错了」。 */
    const dead = async () => {
      try {
        await fetch(APP + 'api/status');
        return false;
      } catch {
        return true;
      }
    };
    const waitGone = async (rounds) => {
      for (let i = 0; i < rounds; i++) {
        if (await dead()) return true;
        await sleep(500);
      }
      return false;
    };
    const gracefulKill = async () => {
      spawn('taskkill', ['/pid', String(inst.proc.pid)], { stdio: 'ignore', windowsHide: true });
      return waitGone(10);
    };
    const scriptClose = async () => {
      try {
        /* 别用 evalJs 等回包：窗口一关这条 WebSocket 就断了，回包永远不来，
           于是要干等到 15s 超时 —— 6 次关闭白等 90 秒，还会把别的失败掩盖在后面。 */
        await cdp.send('Runtime.evaluate', { expression: 'window.close()' }, 1200);
      } catch {
        /* 窗口先消失时这里会断开，属正常 */
      }
      return waitGone(10);
    };

    let graceful = await gracefulKill();
    if (!graceful) graceful = await scriptClose();
    if (!graceful) {
      try {
        const ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
        const bc = connect(ver.webSocketDebuggerUrl);
        await bc.ready;
        await bc.send('Browser.close', {}, 5000);
        bc.ws.close();
      } catch {
        /* 拿不到浏览器端点就算了 */
      }
      graceful = await waitGone(12);
    }

    try {
      cdp.ws.close();
    } catch {
      /* noop */
    }
    inst.kill(); // 万一没退干净
    // 必须等进程和端口都真的空出来，否则下一个实例起不来（CDP 端口被占）
    await waitProcessGone(inst.proc.pid);
    await waitCdpFree();
    await sleep(400);
    return graceful;
  };

  return { inst, cdp, inner, close };
}

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return null;
  }
};

(async () => {
  if (!fs.existsSync(EXE)) throw new Error(`没有 ${EXE}，先运行 npm run build:app`);
  rmQuiet(WORK);
  rmQuiet(DATA);
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });

  /* ---------- A. 首次启动 + 正常关闭 → 保存 ---------- */
  const a = await boot('首次启动');
  const [w0, h0] = a.inner;
  console.log(`首次启动视口 ${w0}x${h0}`);
  check('首次启动用默认尺寸', () => (w0 > 1200 ? true : `视口只有 ${w0} 宽`));

  /* 触发一次真实的尺寸变化，让「resize → 防抖保存」这条路跑起来。
   *
   * 早先只靠 window.close() 收尾，结果状态文件根本没写出来 —— 那条路似乎
   * 不经过 BrowserWindow 的 close 事件。改尺寸这条路更贴近日常使用
   * （用户拖窗口大小），而且不依赖关闭时序。 */
  await a.cdp.evalJs('window.resizeTo(1040, 700)');
  await sleep(1400); // 主进程里防抖是 400ms
  const resized = JSON.parse(await a.cdp.evalJs('JSON.stringify([window.innerWidth, window.innerHeight])'));
  console.log(`改尺寸后视口 ${resized[0]}x${resized[1]}`);
  check('页面能改窗口尺寸（测试前提）', () =>
    Math.abs(resized[0] - w0) > 50 ? true : 'resizeTo 没生效，下面的保存断言测不到'
  );

  /* 再改一次尺寸，然后**立刻**关窗 —— 这次不等防抖。
   *
   * 防抖是 400ms，用户完全可能拖完尺寸马上点关闭，那时定时器还没到点，
   * 只剩 win.on('close') 兜底。这里把「兜底那一路到底有没有生效」钉住：
   * 只等 100ms（远小于 400ms），盘上必须是第二个尺寸而不是第一个。
   *
   * 用两个差得很远的尺寸，避免「防抖碰巧先落盘了」把失败伪装成通过。 */
  const FINAL = [1220, 820];
  await a.cdp.evalJs(`window.resizeTo(${FINAL[0]}, ${FINAL[1]})`);
  await sleep(100);
  const last = JSON.parse(await a.cdp.evalJs('JSON.stringify([window.innerWidth, window.innerHeight])'));
  console.log(`关窗前最后视口 ${last[0]}x${last[1]}（不等防抖，直接关）`);

  const graceful1 = await a.close();
  console.log(`  （关闭方式：${graceful1 ? '正常关闭' : '强杀'}）`);

  const s1 = readState();
  check('改尺寸后写出状态文件', () => (s1 ? true : STATE + ' 不存在'));
  // 主进程的调试日志一律带出来 —— 保存没生效时，日志里的事件顺序就是唯一的线索
  console.log('  应用日志（末 900 字）：');
  console.log('    ' + a.inst.log.join('').slice(-900).replace(/\n/g, '\n    '));
  if (!s1) {
    console.log('  （状态文件不存在）');
  } else {
    console.log('  状态文件: ' + JSON.stringify(s1));
    check('存了坐标', () => (Number.isFinite(s1.x) && Number.isFinite(s1.y) ? true : JSON.stringify(s1)));
    check('未最大化时 maximized 为 false', () => (s1.maximized === false ? true : String(s1.maximized)));
    check('改完尺寸立刻关窗也被记住（不依赖防抖）', () =>
      Math.abs(s1.width - last[0]) <= TOL_LOOSE && Math.abs(s1.height - last[1]) <= TOL_LOOSE
        ? true
        : `关窗前视口 ${last[0]}x${last[1]}，盘上却是 ${s1.width}x${s1.height}`
    );
    check('状态文件带格式版本号', () => (s1.v === 3 ? true : `v=${s1.v}，旧格式会被当作没有状态文件`));
  }

  /* ---------- B. 重开 → 回到关闭前的尺寸 ----------
   *
   * 注意容差是 TOL_LOOSE：这一步跨了一次「存盘 → 重建」，中间要做两次 DPI 取整
   * （见文件头的说明），所以会差 1~3px。这不是漂移，别收紧。 */
  const b = await boot('重开');
  const [w1, h1] = b.inner;
  console.log(`重开后视口   ${w1}x${h1}`);
  check('重开后恢复到关闭前的尺寸', () =>
    Math.abs(w1 - last[0]) <= TOL_LOOSE && Math.abs(h1 - last[1]) <= TOL_LOOSE
      ? true
      : `关窗前 ${last[0]}x${last[1]}，重开后 ${w1}x${h1}`
  );
  await b.close();

  /* ---------- B2. 再重开一次 → 必须与上一次**完全**一致 ----------
   *
   * 这才是「有没有漂移」的真正判据。同样输入进、同样输出出，误差只允许 1px
   * （纯粹的量取噪声）。如果单位真的不一致，这里会看到每轮稳定 +Npx 的累积。 */
  const b2 = await boot('再重开');
  const [w1b, h1b] = b2.inner;
  console.log(`再重开视口   ${w1b}x${h1b}`);
  check('再次重开尺寸完全不变（不累积漂移）', () =>
    Math.abs(w1b - w1) <= TOL_EXACT && Math.abs(h1b - h1) <= TOL_EXACT
      ? true
      : `上次 ${w1}x${h1}，这次 ${w1b}x${h1b}`
  );
  await b2.close();

  /* ---------- C. 外部指定的尺寸要被采纳，且再次开关不漂移 ---------- */
  const SEED = { v: 3, x: 150, y: 120, width: 1000, height: 660, maximized: false };
  fs.writeFileSync(STATE, JSON.stringify(SEED, null, 2) + '\n', 'utf8');
  const c = await boot('指定尺寸');
  const [w2, h2] = c.inner;
  console.log(`指定 1000x660 后视口 ${w2}x${h2}`);
  check('采纳了状态文件里的尺寸', () =>
    Math.abs(w2 - w0) > 100 ? true : `视口仍是 ${w2}，没采纳`
  );
  await c.close();

  const d = await boot('指定尺寸重开');
  const [w3, h3] = d.inner;
  console.log(`再开一次视口 ${w3}x${h3}`);
  check('再次开关仍不漂移', () =>
    Math.abs(w3 - w2) <= TOL_EXACT && Math.abs(h3 - h2) <= TOL_EXACT
      ? true
      : `上次 ${w2}x${h2}，这次 ${w3}x${h3}`
  );
  await d.close();

  /* ---------- D. 离屏坐标要被丢弃 ---------- */
  fs.writeFileSync(STATE, JSON.stringify({ v: 3, x: -99999, y: -99999, width: 1000, height: 660, maximized: false }) + '\n', 'utf8');
  const e = await boot('离屏坐标');
  const onScreen = await e.cdp.evalJs('window.screenX > -5000 && window.screenX < screen.width + 500');
  check('离屏坐标被丢弃（窗口仍在屏幕内）', () => (onScreen === true ? true : '窗口被开到了屏幕外'));
  check('丢弃坐标时仍保留尺寸', () =>
    Math.abs(e.inner[0] - w2) <= TOL_EXACT ? true : `视口 ${e.inner[0]}，期望约 ${w2}`
  );
  await e.close();

  let pass = 0;
  for (const [st, name, msg] of results) {
    if (st === 'PASS') pass++;
    console.log(`${st === 'PASS' ? '  ok  ' : ' FAIL '} ${name}${msg ? '  → ' + msg : ''}`);
  }
  console.log(`\n${pass}/${results.length} 通过`);
  rmQuiet(WORK);
  rmQuiet(DATA);
  setTimeout(() => process.exit(pass === results.length ? 0 : 1), 700);
})().catch((err) => {
  console.log('失败: ' + err.message);
  process.exit(1);
});
