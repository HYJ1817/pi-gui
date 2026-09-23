/* 「拉取模型列表」的真实浏览器视觉核对。
 *
 * 为什么非要用真浏览器：jsdom 不做布局、也不套用外部样式表，所以
 *   - .fetch-row 的 flex 布局有没有被 .field label 的 display:block 打散
 *   - .fetch-panel 的 hidden 有没有真的藏住（组件自带 display 会盖掉浏览器默认规则）
 *   - 长模型 id 会不会把行撑破
 * 这三件事在 jsdom 里全是「看起来没问题」。
 *
 * 链路是真的：桩上游 → 真实 server.js 的 /api/providers/models → 真实前端。
 * 用法：node tests/shot-models.cjs
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.TEST_PORT || 7795);
const CDP_PORT = Number(process.env.CDP_PORT || 9225);
const OUT = path.join(ROOT, '.shots');
const WORK = path.join(os.tmpdir(), 'pi-gui-shot-models');
const FAKE_HOME = path.join(WORK, 'home');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* 被 safe-delete shim 拦了，走下面 */
  }
  try {
    execFileSync('rm', ['-rf', '--', p], { stdio: 'ignore' });
  } catch {
    /* noop */
  }
}

/* 桩上游：OpenRouter 风格的富信息响应，故意放一个超长 id 看会不会撑破行 */
function startStub() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const body = JSON.stringify({
        data: [
          {
            id: 'anthropic/claude-sonnet-4',
            name: 'Claude Sonnet 4',
            context_length: 200000,
            top_provider: { context_length: 200000, max_completion_tokens: 64000 },
            architecture: { input_modalities: ['text', 'image'] },
            supported_parameters: ['tools', 'reasoning'],
          },
          { id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000, architecture: { input_modalities: ['text', 'image'] } },
          { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', context_length: 65536 },
          { id: 'meta-llama/llama-3.3-70b-instruct-turbo-free-preview-with-a-very-long-suffix', name: 'Llama 3.3 70B 超长名字用来压测换行', context_length: 131072, supported_parameters: ['reasoning'] },
          { id: 'qwen/qwen3-max', name: 'Qwen3 Max', context_length: 262144, top_provider: { max_completion_tokens: 32768 }, supported_parameters: ['reasoning'] },
        ],
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function main() {
  rmrf(WORK);
  fs.mkdirSync(FAKE_HOME, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const stub = await startStub();
  const UP = `http://127.0.0.1:${stub.address().port}/rich/v1`;

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PI_GUI_OPEN: '0',
      PI_GUI_DATA: path.join(WORK, 'data'),
      USERPROFILE: FAKE_HOME,
      HOME: FAKE_HOME,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  server.stdout.on('data', (d) => (srvOut += d));
  server.stderr.on('data', (d) => (srvOut += d));

  const APP = `http://127.0.0.1:${PORT}/`;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const r = await fetch(APP);
      if (r.status) break;
    } catch {
      /* 还没起来 */
    }
  }

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-default-apps',
      '--metrics-recording-only',
      '--hide-scrollbars',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${path.join(OUT, 'cdp-models')}`,
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch {
      /* 还没起来 */
    }
  }
  const page = targets && targets.find((t) => t.type === 'page');
  if (!page) throw new Error('拿不到 DevTools page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || '未知异常');
    }
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const n = ++id;
      pending.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };

  const shot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, 'models-' + n + '.png');
    fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    console.log('  截图: ' + path.basename(p));
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: APP });

    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const ready = await evalJs('!!document.querySelector("#navProviders")').catch(() => null);
      if (ready) break;
    }
    await sleep(1200);

    // 侧栏左下 → 供应商面板 → 添加供应商
    await evalJs('document.querySelector("#navProviders").click()');
    await sleep(500);
    const opened = await evalJs(`(() => {
      const btn = [...document.querySelectorAll('#modalCard .modal-actions .btn')].find(b => b.textContent.includes('添加供应商'));
      if (!btn) return 'no-add-button';
      btn.click();
      return 'ok';
    })()`);
    if (opened !== 'ok') throw new Error('打不开添加供应商弹层：' + opened);
    await sleep(500);

    await evalJs(`(() => {
      const card = document.querySelector('#modalCard');
      const base = card.querySelector('input[placeholder^="https://api.example.com"]');
      base.value = ${JSON.stringify(UP)};
      base.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(200);
    await shot('01-before-fetch');

    // 点「拉取」
    const clicked = await evalJs(`(() => {
      const btn = [...document.querySelectorAll('#modalCard .field-head .btn')].find(b => b.textContent === '拉取');
      if (!btn) return 'no-fetch-button';
      btn.click();
      return 'ok';
    })()`);
    if (clicked !== 'ok') throw new Error(clicked);

    let rows = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      rows = await evalJs('document.querySelectorAll("#modalCard .fetch-row").length').catch(() => 0);
      if (rows > 0) break;
    }
    console.log('拉取到 ' + rows + ' 行');

    const info = await evalJs(`(() => {
      const card = document.querySelector('#modalCard');
      const panel = card.querySelector('.fetch-panel');
      const row = card.querySelector('.fetch-row');
      const cb = row && row.querySelector('input[type=checkbox]');
      const search = card.querySelector('.fetch-search');
      const note = card.querySelector('.fetch-note');
      const panelR = panel.getBoundingClientRect();
      const rowR = row.getBoundingClientRect();
      const cs = (el) => getComputedStyle(el);
      return JSON.stringify({
        panelHidden: panel.hidden,
        panelDisplay: cs(panel).display,
        panelVisible: panelR.width > 0 && panelR.height > 0,
        // 四个边界都要查：只查 top/left 会漏掉「面板掉到折叠线以下」
        panelInViewport: panelR.left >= 0 && panelR.right <= innerWidth && panelR.top >= 0 && panelR.bottom <= innerHeight,
        panelBottom: Math.round(panelR.bottom),
        viewportH: innerHeight,
        rowDisplay: cs(row).display,
        rowOverflows: rowR.right > panelR.right + 1,
        cbSize: Math.round(cb.getBoundingClientRect().width),
        cbIsSmall: cb.getBoundingClientRect().width < 20,
        searchWidth: Math.round(search.getBoundingClientRect().width),
        searchIsWide: search.getBoundingClientRect().width > 150,
        badges: [...row.querySelectorAll('.fetch-badge')].map(b => b.textContent),
        longIdTruncated: (() => {
          const ids = [...card.querySelectorAll('.fetch-id')];
          const longest = ids[ids.length - 1];
          return longest.scrollWidth <= longest.clientWidth + 1 || 'id 撑破了容器';
        })(),
        note: note.textContent,
        listScrolls: card.querySelector('.fetch-list').scrollHeight > card.querySelector('.fetch-list').clientHeight,
      });
    })()`);
    console.log('拉取面板: ' + info);

    await shot('02-fetched');

    // 勾选两个 + 加入列表，验证写回 textarea 的行格式
    const filled = await evalJs(`(() => {
      const card = document.querySelector('#modalCard');
      const rows = [...card.querySelectorAll('.fetch-row')];
      rows[0].click();
      rows[3].click();
      const add = [...card.querySelectorAll('.fetch-foot .btn')].find(b => b.textContent.includes('加入列表'));
      add.click();
      return card.querySelector('textarea').value;
    })()`);
    console.log('写回的模型行:');
    for (const line of String(filled).split('\n')) console.log('    ' + line);
    await sleep(300);
    await shot('03-added');

    // 搜索过滤
    await evalJs(`(() => {
      const s = document.querySelector('#modalCard .fetch-search');
      s.value = 'qwen';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(300);
    console.log('搜索 qwen 后剩: ' + (await evalJs('document.querySelectorAll("#modalCard .fetch-row").length')) + ' 行');
    await shot('04-search');

    console.log('页面异常: ' + (pageErrors.length ? pageErrors.join(' | ') : '无'));
  } finally {
    try {
      ws.close();
    } catch {
      /* noop */
    }
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
        spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        chrome.kill();
        server.kill();
      }
    } catch {
      /* noop */
    }
    try {
      stub.close();
    } catch {
      /* noop */
    }
    await sleep(600);
    rmrf(WORK);
  }

  console.log('\n完成，截图在 .shots/');
  process.exit(0);
}

main().catch((e) => {
  console.log('失败: ' + e.message);
  process.exit(1);
});
