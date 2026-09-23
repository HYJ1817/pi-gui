/* 诊断用：打包应用的调试端口到底能不能求值。
 *
 * 现象：e2e-app.cjs 里 Runtime.enable 能回来，但 Runtime.evaluate 挂住。
 * 这个脚本把原始响应打出来，看是「命令没回」还是「回了但没匹配上」。
 *
 * 用法：
 *   node tests/diag-cdp.cjs          # 连打包后的 exe
 *   DIAG_MODE=dev node tests/diag-cdp.cjs   # 连开发模式 electron .
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MODE = process.env.DIAG_MODE || 'exe';
const EXE = path.join(ROOT, 'dist-app', 'Pi GUI-win32-x64', 'Pi GUI.exe');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const APP_PORT = Number(process.env.E2E_PORT || 7788);
const CDP_PORT = Number(process.env.CDP_PORT || 9224);
const APP = `http://127.0.0.1:${APP_PORT}/`;
const WORK = path.join(os.tmpdir(), 'pi-gui-diag-work');
const DATA = path.join(os.tmpdir(), 'pi-gui-diag-data');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rmQuiet = (p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* 被占用就留着，下次启动前再清 */
  }
};

function connect(url, label) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const raw = [];
  ws.addEventListener('message', (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch (e) {
      raw.push(`[${label}] 解析失败: ${String(ev.data).slice(0, 120)}`);
      return;
    }
    raw.push(`[${label}] ← ${JSON.stringify(m).slice(0, 200)}`);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws error')));
  });
  const send = (method, params = {}, ms = 8000) =>
    new Promise((res, rej) => {
      const n = ++id;
      pending.set(n, res);
      raw.push(`[${label}] → ${method}`);
      ws.send(JSON.stringify({ id: n, method, params }));
      setTimeout(() => {
        pending.delete(n);
        rej(new Error(`超时 ${ms}ms: ${method}`));
      }, ms);
    });
  return { ws, ready, send, raw };
}

async function main() {
  rmQuiet(WORK);
  rmQuiet(DATA);
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });

  const env = { ...process.env, PI_CWD: WORK, PI_GUI_DATA: DATA, PI_GUI_OPEN: '0' };
  delete env.ELECTRON_RUN_AS_NODE;

  /* 默认参数（DIAG_ARGS 可整串覆盖，方便做参数对照实验）：
   *   --no-sandbox     受限环境里 Chromium 沙箱起不来，渲染进程会被杀
   *   --in-process-gpu GPU 进程同样受沙箱所限；有 --no-sandbox 后不再必需
   * 这两条都是「受限环境的绕行手段」，应用本身保留沙箱。 */
  const extra = process.env.DIAG_ARGS
    ? process.env.DIAG_ARGS.split(' ').filter(Boolean)
    : ['--no-sandbox', '--in-process-gpu'];
  const args =
    MODE === 'dev'
      ? ['.', `--remote-debugging-port=${CDP_PORT}`, ...extra]
      : [`--remote-debugging-port=${CDP_PORT}`, ...extra];
  const bin = MODE === 'dev' ? ELECTRON : EXE;
  console.log(`模式: ${MODE}  (${bin})\n`);
  const proc = spawn(bin, args, {
    cwd: MODE === 'dev' ? ROOT : path.dirname(EXE),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));

  try {
    let up = false;
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      try {
        if ((await fetch(APP + 'api/status')).ok) {
          up = true;
          break;
        }
      } catch {}
    }
    if (!up) {
      console.log('后端没起来，应用日志：');
      console.log(log.slice(-2000));
      return;
    }
    console.log('后端就绪\n');

    await sleep(3000);
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    console.log(`调试目标 ${list.length} 个:`);
    for (const t of list) {
      console.log(`  type=${t.type}  title=${JSON.stringify(t.title)}`);
      console.log(`    url=${String(t.url).slice(0, 90)}`);
      console.log(`    ws=${t.webSocketDebuggerUrl}`);
    }
    console.log('');

    const pages = list.filter((t) => t.type === 'page');
    for (const [i, p] of pages.entries()) {
      const label = `page#${i}`;
      console.log(`--- 试 ${label}: ${String(p.url).slice(0, 80)}`);
      const cdp = connect(p.webSocketDebuggerUrl, label);
      try {
        await cdp.ready;
      } catch {
        console.log('  ws 连不上');
        continue;
      }
      for (const [m, params] of [
        ['Runtime.enable', {}],
        ['Runtime.evaluate', { expression: '1+1', returnByValue: true }],
        ['Runtime.evaluate', { expression: 'document.title', returnByValue: true }],
        ['Page.captureScreenshot', { format: 'png' }],
      ]) {
        try {
          const r = await cdp.send(m, params);
          console.log(`  ✓ ${m} → ${JSON.stringify(r).slice(0, 160)}`);
        } catch (e) {
          console.log(`  ✗ ${e.message}`);
        }
      }
      cdp.ws.close();
    }

    console.log('\n--- 应用日志（末 1200 字）---');
    console.log(log.slice(-1200));
  } finally {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
    await sleep(2000);
    rmQuiet(WORK);
    rmQuiet(DATA);
    setTimeout(() => process.exit(0), 500);
  }
}

main().catch((e) => {
  console.log('失败: ' + e.message);
  process.exit(1);
});
