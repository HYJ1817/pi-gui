/* 打包后的桌面应用端到端验收。
 *
 * 前面的测试各自覆盖一段：app-check 测后端、shot-app 测窗口渲染。
 * 这里把整条链路串起来跑一次，用的是打包产物本身：
 *
 *   双击的 Pi GUI.exe → Electron 窗口 → 内嵌后端 → pi 子进程 → 事件流 → 界面
 *
 * 隔离措施（很重要，否则会污染用户真实数据）：
 *   - PI_CWD 指向临时目录 → pi 的会话存在那里，不动用户主目录的历史
 *   - PI_GUI_DATA 指向临时目录 → projects.json / 上传缓存也不落进用户数据目录
 *
 * 需要真实桌面会话（沙箱里 Electron 起不来），所以这个脚本要在能开 GUI 的环境跑。
 * 用法：npm run build:app && node tests/e2e-app.cjs
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

const WORK = path.join(os.tmpdir(), 'pi-gui-e2e-work');
const WORK_B = path.join(os.tmpdir(), 'pi-gui-e2e-work-b');
const DATA = path.join(os.tmpdir(), 'pi-gui-e2e-data');
const ASK = '请只回复两个字：收到';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Node 侧监听事件流 ---------- */
function watchEvents(sink) {
  const ac = new AbortController();
  fetch(APP + 'api/events', { signal: ac.signal })
    .then(async (r) => {
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const part = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = part.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          try {
            sink(JSON.parse(line.slice(5)));
          } catch {
            /* 半包，跳过 */
          }
        }
      }
    })
    .catch(() => {
      /* abort 时正常报错 */
    });
  return () => ac.abort();
}

/* ---------- CDP ---------- */

/** 等窗口出现**且页面已经加载**。
 *
 * 调试目标一创建就会出现，但那时 title 还是空的 —— 页面加载完才会填上
 * （title 由渲染进程提供）。所以要轮询到 title 非空，才算真的可连。
 * 超时就把「渲染进程是否被杀」一起报出来，省得下游只看到一串 Runtime 超时。
 */
async function pickPage(deadlineMs = 60000) {
  const end = Date.now() + deadlineMs;
  let sawTarget = false;
  let lastTitle = null;
  while (Date.now() < end) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.url.includes(String(APP_PORT)));
      if (p) {
        sawTarget = true;
        lastTitle = p.title;
        if (p.title) return p;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  throw new Error(
    sawTarget
      ? `页面一直没加载完（调试目标在，但 title 始终为空，最后是 ${JSON.stringify(lastTitle)}）`
      : '等不到应用窗口的调试目标'
  );
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const errs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === 'Runtime.exceptionThrown') {
      errs.push(m.params?.exceptionDetails?.text || 'exception');
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('WebSocket 连不上')));
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id;
      pending.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
      setTimeout(() => rej(new Error('超时: ' + method)), 20000);
    });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 200));
    return r.result?.result?.value;
  };
  return { ws, ready, send, evalJs, errs };
}

async function waitFor(evalJs, expr, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evalJs(expr)) return true;
    await sleep(400);
  }
  throw new Error('等超时: ' + label);
}

/* ---------- 主流程 ---------- */
async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`没有 ${EXE}，先运行 npm run build:app`);

  fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(WORK_B, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  console.log('隔离目录:');
  console.log('  工作目录 ' + WORK);
  console.log('  数据目录 ' + DATA);

  const env = { ...process.env, PI_CWD: WORK, PI_GUI_DATA: DATA, PI_GUI_OPEN: '0' };
  // 这个变量会把 electron.exe 降级成普通 node，GUI 就起不来了
  delete env.ELECTRON_RUN_AS_NODE;

  /* 启动参数说明（实测得出，别随便删）：
   *
   * --no-sandbox
   *   这个环境里 Chromium 沙箱起不来，渲染进程一启动就被杀，症状是
   *   「窗口不显示 + Runtime 域全部超时 + 前端没有任何网络请求」。
   *   加了它渲染进程才活得下来。**这是受限环境的绕行手段，不是应用该有的
   *   默认行为** —— 应用本身保留沙箱，别把这条写进 main.cjs。
   *
   * --in-process-gpu
   *   GPU 进程同样是沙箱受害者。有了 --no-sandbox 之后其实不再必需，
   *   留着只是为了让这轮验收在更差的环境下也能跑。
   */
  const appProc = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--in-process-gpu'], {
    cwd: path.dirname(EXE),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let appLog = '';
  appProc.stdout.on('data', (d) => (appLog += d));
  appProc.stderr.on('data', (d) => (appLog += d));

  const killApp = () => {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(appProc.pid), '/T', '/F'], { stdio: 'ignore' });
      else appProc.kill();
    } catch {
      /* 已经退出 */
    }
  };

  let stopWatch = () => {};
  let ws;
  let reopenedProc;
  let reopenedWs;
  try {
    /* 1. 后端起来 */
    let up = false;
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      try {
        if ((await fetch(APP + 'api/health')).ok) {
          up = true;
          break;
        }
      } catch {
        /* 还没起来 */
      }
    }
    if (!up) throw new Error('应用后端没起来：\n' + appLog.slice(0, 600));
    console.log('\n1) 应用已启动（窗口 + 内嵌后端都在）');

    /* 2. 连窗口 —— 带令牌的事件流只能从 Electron 渲染进程访问 */
    const page = await pickPage().catch((e) => {
      const killed = /Renderer process killed|render-process-gone/.test(appLog);
      throw new Error(
        e.message +
          '\n' +
          (killed ? '  日志里有「Renderer process killed」→ 渲染进程被杀了。\n' : '') +
          '  应用日志：\n' +
          appLog.slice(-800)
      );
    });

    const cdp = connect(page.webSocketDebuggerUrl);
    ws = cdp.ws;
    await cdp.ready;
    // 只开 Runtime（要用它收异常事件 + 求值）。
    // 截图（Page.captureScreenshot）不开 Page 域也能用，所以不特意开。
    await cdp.send('Runtime.enable');
    await cdp.evalJs(`(() => {
      window.__e2eEvents = [];
      window.__e2eSource = new EventSource('/api/events');
      window.__e2eSource.onmessage = e => { try { window.__e2eEvents.push(JSON.parse(e.data)); } catch {} };
    })()`);

    await waitFor(cdp.evalJs, `document.querySelector('#connText')?.textContent === '已连接'`, 40000, 'pi 连接就绪');

    /* 确认「当前项目」就是隔离目录。
     * 界面上的 cwd 来自 /api/status，直接问后端比猜 DOM 选择器稳。
     * 这条要是错了，说明桌面版会去动用户真实的目录，那是很严重的问题。 */
    const status = JSON.parse(await cdp.evalJs(`fetch('/api/status').then(r => r.json()).then(JSON.stringify)`));
    const cwdOk = path.resolve(status.cwd || '') === path.resolve(WORK);
    console.log('2) pi 已连接');
    console.log(`   工作目录 ${status.cwd} ${cwdOk ? '✓ 与隔离目录一致' : '✗ 与隔离目录不符（期望 ' + WORK + '）'}`);

    /* 4. 开新会话，避免读到该目录的旧历史 */
    await cdp.evalJs(`(() => {
      const b = [...document.querySelectorAll('button,.rail-item,.rail-nav *')].find(e => e.textContent.trim() === '新对话');
      if (b) b.click();
    })()`);
    await sleep(2500);

    /* 5. 输入并发送 —— 走和用户一样的路径 */
    await cdp.evalJs(`(() => {
      const t = document.querySelector('#input');
      t.value = ${JSON.stringify(ASK)};
      t.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(400);
    const sendDisabled = await cdp.evalJs(`document.querySelector('#btnSend').disabled`);
    if (sendDisabled) throw new Error('输入后发送按钮仍是禁用状态');
    await cdp.evalJs(`document.querySelector('#btnSend').click()`);
    console.log('3) 已发送: ' + ASK);

    /* 6. 等 pi 跑完 */
    await waitFor(cdp.evalJs, `!document.querySelector('#btnStop').hidden`, 40000, '进入流式状态');
    await waitFor(cdp.evalJs, `document.querySelector('#btnStop').hidden`, 180000, 'pi 结束');
    console.log('4) pi 已结束');

    /* 7. 断言 A：pi 真的收到了这条消息 */
    const events = JSON.parse(await cdp.evalJs(`JSON.stringify(window.__e2eEvents || [])`));
    const userMsg =
      events
        .filter((e) => e.type === 'message_end' && e.message?.role === 'user')
        .map((e) => (Array.isArray(e.message.content) ? e.message.content.map((c) => c.text || '').join('') : ''))
        .pop() || '';
    const reached = userMsg.includes('收到');
    console.log('5) 消息送达 pi: ' + (reached ? '✅ 是' : '❌ 否'));
    if (!reached) console.log('   实际收到: ' + JSON.stringify(userMsg.slice(0, 200)));

    /* 8. 断言 B：界面呈现正常（有回复、有错误块，或至少不是空白） */
    const dom = JSON.parse(
      await cdp.evalJs(`(() => {
        const t = document.querySelector('#stream .thread');
        const ub = [...t.querySelectorAll('.msg.user .msg-body')].pop();
        const ab = [...t.querySelectorAll('.msg.assistant .msg-body')].pop();
        return JSON.stringify({
          userText: (ub?.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 60),
          reply: (ab?.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 160),
          errBlock: ab?.querySelector('.me-head')?.textContent || '',
          stopHidden: document.querySelector('#btnStop').hidden,
        });
      })()`)
    );
    console.log('6) 界面: ' + JSON.stringify(dom));

    /* 在真实窗口里走 A→B→A，确认项目切换后 UI、cwd 与输入状态一致。 */
    fs.mkdirSync(WORK_B, { recursive: true });
    for (const projectPath of [WORK, WORK_B]) {
      const added = JSON.parse(await cdp.evalJs(`fetch('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: ${JSON.stringify(projectPath)} })
      }).then(r => r.json()).then(JSON.stringify)`));
      if (!added.ok) throw new Error('添加隔离项目失败: ' + JSON.stringify(added));
    }
    await cdp.evalJs(`import('/projects.js').then(m => m.loadProjects())`);
    for (const projectPath of [WORK_B, WORK]) {
      const clicked = await cdp.evalJs(`(() => {
        const target = ${JSON.stringify(projectPath)}.toLowerCase();
        const row = [...document.querySelectorAll('.project')].find(e => e.title.toLowerCase() === target);
        if (!row) return false;
        row.click();
        return true;
      })()`);
      if (!clicked) throw new Error('找不到项目行: ' + projectPath);
      await waitFor(cdp.evalJs, `fetch('/api/status').then(r => r.json()).then(s =>
        s.cwd?.toLowerCase() === ${JSON.stringify(projectPath.toLowerCase())} && s.piRunning)`, 40000, '切换到 ' + projectPath);
      await waitFor(cdp.evalJs, `document.querySelector('#connText')?.textContent === '已连接' &&
        !document.querySelector('#input')?.disabled`, 40000, '项目界面同步');
    }
    const beforeConfig = JSON.parse(await cdp.evalJs(`fetch('/api/status').then(r => r.json()).then(JSON.stringify)`)).bridgeRun;
    const saved = JSON.parse(await cdp.evalJs(`fetch('/api/project-config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thinking: 'low', __expectedCwd: ${JSON.stringify(WORK)} })
    }).then(r => r.json()).then(JSON.stringify)`));
    if (!saved.ok) throw new Error('保存隔离项目设置失败: ' + JSON.stringify(saved));
    await waitFor(cdp.evalJs, `fetch('/api/status').then(r => r.json()).then(s =>
      s.bridgeRun > ${beforeConfig} && s.piRunning)`, 40000, '项目配置触发重启');
    console.log('7) 真实窗口 A→B→A、配置保存和 pi 重启：通过');

    const lastAssistant = events.filter((e) => e.type === 'message_end' && e.message?.role === 'assistant').pop();
    const am = lastAssistant?.message || {};
    const apiError = am.stopReason === 'error' || am.errorMessage;
    const renderOk = Boolean(dom.reply || dom.errBlock) && dom.stopHidden;

    // 截图只是取证，不该决定成败
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.join(ROOT, '.shots'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, '.shots', 'e2e-app.png'), Buffer.from(shot.result.data, 'base64'));
      console.log('   截图 → .shots/e2e-app.png');
    } catch (e) {
      console.log('   （截图跳过：' + e.message + '）');
    }

    console.log('');
    const pass = reached && renderOk && cwdOk;
    if (pass && apiError) {
      console.log('⚠️  链路与呈现都正常，但模型调用失败（上游问题，非本项目缺陷）：');
      console.log('    ' + String(am.errorMessage || am.stopReason).slice(0, 180));
      console.log('    界面已把它显示为「' + dom.errBlock + '」');
    } else if (pass) {
      console.log('✅ 端到端通过：窗口 → 后端 → pi → 事件流 → 界面 全部正常');
    } else {
      console.log('❌ 端到端未通过');
    }
    console.log('页面异常: ' + (cdp.errs.length ? cdp.errs.join(' | ') : '无'));
    if (pass) {
      ws.close();
      killApp();
      await Promise.race([new Promise((resolve) => appProc.once('exit', resolve)), sleep(10000)]);
      if (appProc.exitCode === null) throw new Error('关闭应用后进程仍在');
      reopenedProc = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--in-process-gpu'], {
        cwd: path.dirname(EXE),
        env: { ...env, PI_CWD: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const reopenedPage = await pickPage(60000);
      const reopened = connect(reopenedPage.webSocketDebuggerUrl);
      reopenedWs = reopened.ws;
      await reopened.ready;
      await waitFor(reopened.evalJs, `document.querySelector('#connText')?.textContent === '已连接'`, 40000, '重新打开后连接');
      const restored = JSON.parse(await reopened.evalJs(`fetch('/api/status').then(r => r.json()).then(JSON.stringify)`));
      if (path.resolve(restored.cwd || '') !== path.resolve(WORK)) throw new Error('重新打开后没有恢复 A 项目');
      await waitFor(reopened.evalJs, `document.querySelector('#stream')?.textContent.includes(${JSON.stringify(ASK)})`, 40000, '重新打开后历史恢复');
      console.log('8) 关闭并重新打开：项目 A 与消息历史恢复');
    }
    process.exitCode = pass ? 0 : 1;
  } finally {
    stopWatch();
    try {
      ws?.close();
    } catch {
      /* noop */
    }
    try { reopenedWs?.close(); } catch { /* noop */ }
    killApp();
    if (reopenedProc?.pid) {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(reopenedProc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else reopenedProc.kill();
    }
    await sleep(1200);
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.rmSync(WORK_B, { recursive: true, force: true });
    fs.rmSync(DATA, { recursive: true, force: true });
    setTimeout(() => process.exit(process.exitCode ?? 0), 600);
  }
}

main().catch((e) => {
  console.log('失败: ' + e.message);
  process.exit(1);
});
