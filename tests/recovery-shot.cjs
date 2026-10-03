/* Real Chromium against the offline harness and production SSE bus. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const out = path.resolve(__dirname, '../.shots/p25-2'); fs.mkdirSync(out, { recursive: true });
  const app = 'http://127.0.0.1:18797/', port = 9238;
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-sync', '--disable-background-networking', '--disable-component-update', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(out, 'profile')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let ws;
  try {
    let pages;
    for (let i = 0; i < 40; i++) { try { pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (pages.length) break; } catch {} await sleep(150); }
    ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const pending = new Map(), errors = []; let seq = 0;
    ws.onmessage = event => { const m = JSON.parse(event.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
    const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); const file = path.join(out, name + '.png'); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); console.log(file); };
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    const history = await (await fetch(app + 'api/__recovery')).json();
    await fetch(app + 'api/__work-surface/session-reset');
    await fetch(app + 'api/__recovery?state=ready');
    assert.equal(history.backlog, 800); assert.equal(history.historicalReady, false);
    await send('Page.navigate', { url: app }); await sleep(1600);
    const checkReady = async () => {
      assert.equal(await evaluate('document.querySelector("#input").disabled'), false);
      assert.equal(await evaluate('document.querySelector("#connText").textContent'), '已连接');
      assert.notEqual(await evaluate('document.querySelector("#input").placeholder'), '等待 pi 就绪…');
    };
    await checkReady(); await shot('fresh-browser-ready');
    await send('Page.reload'); await sleep(1200); await checkReady();
    await send('Page.navigate', { url: 'about:blank' }); await send('Page.navigate', { url: app }); await sleep(1200); await checkReady();
    await fetch(app + 'api/__recovery?disconnect=1'); await sleep(3500); await checkReady(); await shot('sse-reconnected-ready');
    const order = () => evaluate('[...document.querySelectorAll("#pjSessionsBox .pj-sess-title")].map(r=>r.textContent)');
    const before = await order(); assert.ok(before.length >= 3);
    const target = await evaluate('(()=>{const t=[...document.querySelectorAll(".pj-sess-title")].find(e=>e.textContent.includes("README"));const r=t.closest("button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...target, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...target, button: 'left', clickCount: 1 }); await sleep(350);
    assert.equal(await evaluate('document.querySelector(".pj-sess[aria-current=true]").textContent.includes("README")'), true);
    assert.deepEqual(await order(), before); await shot('session-selection-stable');
    await fetch(app + 'api/__recovery?state=starting'); await send('Page.reload');
    for (let i = 0; i < 40; i++) {
      if (await evaluate('import("/state.js").then(m=>!m.S.restoring && m.S.hasProject && m.S.bridgeInstance==="offline-recovery-harness")')) break;
      await sleep(50);
    }
    await sleep(10500);
    assert.equal(await evaluate('document.querySelector("#input").disabled'), true);
    assert.equal(await evaluate('document.querySelector("#stageNotice").textContent.includes("Pi 状态同步时间过长")'), true);
    await shot('bounded-recovery-notice');
    await fetch(app + 'api/__recovery?state=ready');
    await evaluate('[...document.querySelectorAll("#stageNotice button")].find(b=>b.textContent==="重新同步状态").click()'); await sleep(400); await checkReady();
    assert.deepEqual(errors, []);
    console.log('Chromium: >800 events, fresh page, refresh, new page, SSE reconnect, stable selection, finite recovery and manual resync passed');
  } finally { ws?.close(); chrome.kill(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
