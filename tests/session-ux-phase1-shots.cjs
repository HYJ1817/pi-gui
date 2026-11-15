/* 第一阶段前后对照截图：同一夹具分别跑在基线 public/ 与当前 public/。
 *
 * 用法（在仓库根目录）：
 *   SESSION_UX_SHOTS_LABEL=after  node tests/session-ux-phase1-shots.cjs
 *   SESSION_UX_SHOTS_LABEL=before VISUAL_PUBLIC_ROOT=<baseline>/public node tests/session-ux-phase1-shots.cjs
 *
 * 只用于验收取证，不启动真 pi、不读用户会话；产物在
 * docs/ui/session-ux-phase1-evidence/<label>-*.png。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'ui', 'session-ux-phase1-evidence');
const LABEL = String(process.env.SESSION_UX_SHOTS_LABEL || 'after').replace(/[^a-z0-9-]/gi, '') || 'after';

if (!process.versions.electron) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'session-ux-shots-'));
  fs.mkdirSync(path.join(world, 'user-data'), { recursive: true });
  const electronRoot = path.dirname(require.resolve('electron/package.json'));
  const pathFile = path.join(electronRoot, 'path.txt');
  const binary = fs.existsSync(pathFile)
    ? fs.readFileSync(pathFile, 'utf8').trim()
    : process.platform === 'win32' ? 'electron.exe' : 'electron';
  const executable = path.join(electronRoot, 'dist', binary);
  if (!fs.existsSync(executable)) throw Error('需要已安装的 Electron 运行时；不自动下载');
  const child = spawn(executable, [__filename, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + path.join(world, 'user-data')], {
    env: { ...process.env, SESSION_UX_SHOTS_LABEL: LABEL, SESSION_UX_SHOTS_WORLD: world },
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const world = process.env.SESSION_UX_SHOTS_WORLD;
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  let win;
  let harness;
  let exitCode = 0;
  const shots = [];

  app.setPath('userData', path.join(world, 'user-data'));
  app.on('window-all-closed', () => {});

  const read = (script) => win.webContents.executeJavaScript(script, true);
  const shot = async (name) => {
    await sleep(140);
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `${LABEL}-${name}.png`);
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
    shots.push(path.basename(file));
    console.log('SHOT ' + path.basename(file));
  };
  const click = async (selector) => {
    const point = await read(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!point) return false;
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await sleep(140);
    return true;
  };
  const setTheme = async (theme) => {
    await read(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    await sleep(200);
  };
  const bringIntoView = async (selector) => {
    await read(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      const s = document.querySelector('#stream');
      if (!e || !s) return false;
      const er = e.getBoundingClientRect(), sr = s.getBoundingClientRect();
      s.scrollTop += er.top - sr.top - 140;
      return true;
    })()`);
    await sleep(180);
  };

  async function main() {
    await app.whenReady();
    harness = spawn(process.execPath, [path.join(ROOT, 'tests/visual-harness.cjs')], {
      cwd: world,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0', VISUAL_UPLOAD_DIR: path.join(world, 'uploads') },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const url = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(Error('离线 harness 启动超时')), 20000);
      harness.stdout.on('data', (chunk) => {
        text += chunk;
        const match = text.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      harness.once('exit', (code) => { clearTimeout(timer); reject(Error('harness exited ' + code)); });
    });

    win = new BrowserWindow({
      width: 1320, height: 820, useContentSize: true, show: true, backgroundColor: '#ffffff',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    await win.loadURL(url);
    await sleep(2200);

    await read(`(async () => {
      window.__surface = await import('/ui/workspace-surface.js');
      window.__S = (await import('/state.js')).S;
      window.__M = await import('/messages.js');
      window.__T = await import('/tools.js');
      Object.assign(__S, { hasProject: true, bridgeState: 'ready', streaming: false, stopping: false });
      __surface.showChat();
      return true;
    })()`);
    await sleep(180);

    /* 1. 工具组默认状态：两个已结束 + 一个仍在运行。 */
    await read(`(async () => {
      __M.clearThread();
      __T.resetTimeline();
      __M.onMessageStart({ message: { role: 'user', content: [{ type: 'text', text: '检查工具执行过程的显示' }] } });
      __M.onMessageStart({ message: { role: 'assistant' } });
      __T.onToolStart({ toolCallId: 's-read', toolName: 'read', args: { path: 'public/messages.js' } });
      __T.onToolEnd({ toolCallId: 's-read', isError: false, result: { content: [{ type: 'text', text: '已读取 812 行' }] } });
      __T.onToolStart({ toolCallId: 's-bash', toolName: 'bash', args: { command: 'npm test -- agent-execution' } });
      await new Promise(resolve => setTimeout(resolve, 220));
      __T.onToolEnd({ toolCallId: 's-bash', isError: true, result: { content: [{ type: 'text', text: 'AssertionError: expected 2/5, got 1/5\\nCommand exited with code 1' }] } });
      __T.onToolStart({ toolCallId: 's-grep', toolName: 'grep', args: { pattern: 'gui_plan', path: 'public' } });
      return true;
    })()`);
    await sleep(300);
    await setTheme('dark');
    await bringIntoView('.tl-group');
    await shot('01-group-default-dark');
    await setTheme('light');
    await bringIntoView('.tl-group');
    await shot('02-group-default-light');
    win.setContentSize(700, 600);
    await sleep(260);
    await setTheme('dark');
    await bringIntoView('.tl-group');
    await shot('03-group-default-narrow-700-dark');
    win.setContentSize(1320, 820);
    await sleep(240);

    /* 2. 单条消息 Token 元信息：默认摘要 + 完整明细。 */
    await read(`(async () => {
      __M.clearThread();
      __M.rebuildFromMessages([
        { role: 'user', content: [{ type: 'text', text: '检查 Token 展示' }] },
        { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '已完成检查：读取通过，测试有一处失败。' }],
          usage: { input: 1200, output: 340, cacheRead: 800, reasoning: 120, totalTokens: 1540 } },
      ]);
      return true;
    })()`);
    await sleep(220);
    await setTheme('dark');
    await bringIntoView('.ui2-msg-meta');
    await shot('04-token-default-dark');
    if (await read(`!!document.querySelector('.ui2-msg-meta-details > summary')`)) {
      await click('.ui2-msg-meta-details > summary');
      await shot('05-token-expanded-dark');
    }
    await setTheme('light');
    await bringIntoView('.ui2-msg-meta');
    await shot('06-token-default-light');

    /* 3. 轮次终态：工具失败只计数，不把整轮判失败。 */
    await read(`(async () => {
      __M.clearThread();
      __T.resetTimeline();
      if (typeof __M.beginTurn === 'function') __M.beginTurn();
      __M.onMessageStart({ message: { role: 'user', content: [{ type: 'text', text: '检查轮次终态' }] } });
      __M.onMessageStart({ message: { role: 'assistant' } });
      __T.onToolStart({ toolCallId: 't-read', toolName: 'read', args: { path: 'public/messages.js' } });
      __T.onToolEnd({ toolCallId: 't-read', isError: false, result: { content: [{ type: 'text', text: '已读取 812 行' }] } });
      __T.onToolStart({ toolCallId: 't-bash', toolName: 'bash', args: { command: 'npm test -- agent-execution' } });
      await new Promise(resolve => setTimeout(resolve, 220));
      __T.onToolEnd({ toolCallId: 't-bash', isError: true, result: { content: [{ type: 'text', text: 'AssertionError\\nCommand exited with code 1' }] } });
      __M.onMessageEnd({ message: { role: 'assistant', content: [{ type: 'text', text: '检查完成。' }], stopReason: 'stop',
        usage: { input: 900, output: 120, reasoning: 40, totalTokens: 1020 } } });
      __M.onSettled();
      return true;
    })()`);
    await sleep(280);
    await setTheme('dark');
    await bringIntoView('.turn-outcome');
    await shot('07-turn-end-dark');
    await setTheme('light');
    await bringIntoView('.turn-outcome');
    await shot('08-turn-end-light');

    /* 4. 自动重试：错误块撤掉后，当前版本保留可展开摘要；基线版本留空。 */
    await read(`(async () => {
      __M.clearThread();
      __M.onMessageStart({ message: { role: 'user', content: [{ type: 'text', text: '继续排查这个失败' }] } });
      __M.onMessageStart({ message: { role: 'assistant' } });
      __M.onMessageEnd({ message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '429 Too Many Requests' } });
      window.__capturedError = typeof __M.captureTrailingError === 'function' ? __M.captureTrailingError() : null;
      return true;
    })()`);
    await sleep(220);
    await setTheme('dark');
    await bringIntoView('.msg-err');
    await shot('09-error-before-retry-dark');
    await read(`(async () => {
      __M.dropTrailingError();
      if (typeof __M.showRetryNotice === 'function') {
        __M.showRetryNotice({ attempt: 1, maxAttempts: 3, error: window.__capturedError });
      }
      return true;
    })()`);
    await sleep(220);
    await bringIntoView('.thread');
    await shot('10-after-retry-dark');
    await setTheme('light');
    await bringIntoView('.thread');
    await shot('11-after-retry-light');

    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${LABEL}-report.json`), JSON.stringify({
      label: LABEL,
      publicRoot: process.env.VISUAL_PUBLIC_ROOT || path.join(ROOT, 'public'),
      shots,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome },
      capturedAt: new Date().toISOString(),
    }, null, 2));
    console.log(`Phase 1 shots ${LABEL}: ${shots.length} 张 -> ${OUT}`);
  }

  main().catch((error) => {
    console.error(error);
    exitCode = 1;
  }).finally(async () => {
    win?.destroy();
    harness?.kill();
    await sleep(120);
    app.exit(exitCode);
  });
}
