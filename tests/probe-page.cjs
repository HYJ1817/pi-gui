/* 临时探针：看夹具页面上桥接事件到底有没有被处理。
 * 只用于排查，不属于产品代码。 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9224;
const APP = process.argv[2] || 'http://127.0.0.1:7789/';
const OUT = path.join(__dirname, '..', '.shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = spawn(
    CHROME,
    [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--disable-sync', '--disable-component-update', '--disable-background-networking',
      '--disable-default-apps', '--metrics-recording-only', '--hide-scrollbars',
      `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(OUT, 'probe')}`,
      '--window-size=1440,900', 'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = await r.json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch { /* 等 */ }
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('EXC: ' + (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text));
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.navigate', { url: APP });
  await sleep(6000);

  console.log('connText      : ' + (await evalJs('document.querySelector("#connText").textContent')));
  console.log('modelText     : ' + (await evalJs('document.querySelector("#modelText").textContent')));
  console.log('thinkText     : ' + (await evalJs('document.querySelector("#thinkText").textContent')));
  console.log('ctxPct        : ' + (await evalJs('document.querySelector("#ctxPct").textContent')));
  console.log('stream 子节点  : ' + (await evalJs('document.querySelector("#stream").children.length')));
  console.log('有 .thread    : ' + (await evalJs('!!document.querySelector("#stream .thread")')));
  console.log('有 #welcome   : ' + (await evalJs('!!document.querySelector("#welcome")')));
  console.log('toast 内容    : ' + (await evalJs('[...document.querySelectorAll(".toast")].map(x=>x.textContent).join(" | ") || "无"')));
  console.log('控制台        : ' + (logs.length ? logs.join('\n                ') : '无'));

  // 手动往事件流推，确认前端收不收得到
  console.log('\n--- 手动推送 ---');
  for (const what of ['state', 'stats', 'models', 'user']) {
    const r = await evalJs(`fetch('/api/__push?what=${what}').then(r=>r.text())`);
    await sleep(700);
    console.log(`push ${what.padEnd(6)} → ` + (await evalJs(`JSON.stringify({
      model: document.querySelector('#modelText').textContent,
      think: document.querySelector('#thinkText').textContent,
      ctx: document.querySelector('#ctxPct').textContent,
      thread: !!document.querySelector('#stream .thread'),
      files: document.querySelectorAll('.msg-file').length,
    })`)));
  }

  ws.close(); chrome.kill(); process.exit(0);
}
main().catch((e) => { console.log('失败: ' + e.message); process.exit(1); });
