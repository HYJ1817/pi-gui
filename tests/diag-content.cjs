/* 一次性诊断：把「请求的尺寸」与「实际得到的客户区尺寸」之间的关系量清楚。
 *
 * 背景（这是本项目最花时间的一个坑，写下来免得以后重踩）：
 *   窗口状态记忆里，「存下来的尺寸」和「下次构造时请求的尺寸」之间一直差 1~4px，
 *   于是每启动一次窗口就涨一点 —— 连开 4 次 1000 → 1004。试过改用
 *   getContentBounds + useContentSize（存取同源），**没用**，照样漂。
 *
 * 说明偏差出在「Electron 实际给出的客户区 ≠ 请求值」这一步，而不是「存错了字段」。
 * 这个脚本就是在量这一步：单实例启动，主进程在 ready-to-show 和 t+1200ms 各打一次
 * getBounds / getContentBounds / getNormalBounds，页面同时报 innerWidth/innerHeight。
 *
 * 用法（必须带 PI_GUI_DEBUG，主进程靠它开日志）：
 *   PI_GUI_DEBUG=1 node tests/diag-content.cjs
 * 需要真实桌面会话。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist-app', 'Pi GUI-win32-x64', 'Pi GUI.exe');
const APP_PORT = 7801;
const CDP_PORT = 9235;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const WORK = path.join(os.tmpdir(), 'pi-gui-dc-work');
const DATA = path.join(os.tmpdir(), 'pi-gui-dc-data');
const STATE = path.join(DATA, 'window-state.json');

/* 种子尺寸可以从命令行给，方便看不同尺寸下偏差是不是常数：
 *   node tests/diag-content.cjs 1000x660
 * 默认 1000x660。 */
const [SW, SH] = (process.argv[2] || '1000x660').split('x').map(Number);
const ROUNDS = Number(process.argv[3] || 3);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    return r.result?.result?.value;
  };
  return { ws, ready, send, evalJs };
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

async function boot(label) {
  const env = { ...process.env, PI_CWD: WORK, PI_GUI_DATA: DATA, PI_GUI_OPEN: '0', PORT: String(APP_PORT) };
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
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    throw new Error(`${label}: 页面没加载完。日志：\n` + log.join('').slice(-600));
  }
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await sleep(1200); // 等主进程 t+1200 那次 dump 也落进日志
  const inner = JSON.parse(await cdp.evalJs('JSON.stringify([window.innerWidth, window.innerHeight])'));

  const close = async () => {
    /* 必须走真实关闭路径，否则测的是「文件根本没被重写」这个假象 ——
     * 这个坑我踩了两次：window.close() 不发 close 事件，新建窗口又没有 resize/move，
     * 于是 lastBounds 一直是 null，saveWindowState 直接 return，文件冻在种子上，
     * 看起来「完全不漂」。所以先 taskkill（不带 /F，发 WM_CLOSE），再退到 window.close()。 */
    spawn('taskkill', ['/pid', String(proc.pid)], { stdio: 'ignore', windowsHide: true });
    let gone = false;
    for (let i = 0; i < 20; i++) {
      if (!(await pidAlive(proc.pid))) {
        gone = true;
        break;
      }
      await sleep(300);
    }
    if (!gone) {
      try {
        await cdp.send('Runtime.evaluate', { expression: 'window.close()' }, 1200);
      } catch {
        /* noop */
      }
      for (let i = 0; i < 20; i++) {
        if (!(await pidAlive(proc.pid))) break;
        await sleep(300);
      }
    }
    try {
      cdp.ws.close();
    } catch {
      /* noop */
    }
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 30; i++) {
      if (!(await pidAlive(proc.pid))) break;
      await sleep(250);
    }
    await sleep(500);
  };

  return { proc, log, inner, close };
}

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return null;
  }
};

const show = (s) => (s ? `x=${s.x} y=${s.y} ${s.width}x${s.height} v=${s.v}` : '(无)');

(async () => {
  if (!fs.existsSync(EXE)) throw new Error(`没有 ${EXE}`);
  if (!process.env.PI_GUI_DEBUG) console.log('提示：没设 PI_GUI_DEBUG，主进程不会打矩形日志\n');
  for (const p of [WORK, DATA]) fs.rmSync(p, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });

  fs.writeFileSync(STATE, JSON.stringify({ v: 2, x: 150, y: 120, width: SW, height: SH, maximized: false }) + '\n', 'utf8');
  console.log(`种子 ${SW}x${SH}\n`);

  for (let round = 1; round <= ROUNDS; round++) {
    const before = readState();
    const inst = await boot(`第 ${round} 轮`);
    console.log(`--- 第 ${round} 轮 ---`);
    console.log(`  读入  ${show(before)}`);
    console.log(`  页面  inner=${inst.inner.join('x')}`);
    const lines = inst.log.join('').split('\n').filter((l) => l.includes('[Pi GUI][debug]'));
    for (const l of lines) console.log('  ' + l.replace(/^\[Pi GUI\]\[debug\] /, ''));
    await inst.close();
    console.log(`  写出  ${show(readState())}\n`);
  }

  for (const p of [WORK, DATA]) fs.rmSync(p, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 500);
})().catch((e) => {
  console.log('诊断失败: ' + e.message);
  process.exit(1);
});
