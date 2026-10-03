/* Real Chromium screenshots against the offline visual harness only. */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const out = path.resolve(__dirname, '../.shots/p25-1'); fs.mkdirSync(out, { recursive: true });
  const port = 9237, app = process.env.HOTFIX_HARNESS_URL || 'http://127.0.0.1:18797/';
  const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-sync', '--disable-component-update', '--disable-background-networking', '--no-default-browser-check', '--disable-default-apps', '--metrics-recording-only', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(out, 'profile')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let ws;
  try {
    let pages;
    for (let n = 0; n < 50; n++) { try { pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (pages.length) break; } catch {} await sleep(150); }
    ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let seq = 0; const pending = new Map(), errors = [];
    ws.onmessage = event => { const m = JSON.parse(event.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
    const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); const file = path.join(out, name + '.png'); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); console.log(file); };
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
    await fetch(app + 'api/__hotfix/no-project?value=0', { method: 'POST' });
    await send('Page.navigate', { url: app }); await sleep(1700);
    await evaluate('document.querySelector("#navChanges").click()'); await sleep(350);
    for (const [width, height] of [[900, 700], [1200, 800]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await sleep(180);
      assert.equal(await evaluate('[...document.querySelectorAll(".chg-acts button")].some(b=>b.textContent==="打开")'), false);
      assert.equal(await evaluate('document.querySelector("#chgFilterSession").textContent.includes("本会话编辑")'), true);
      assert.equal(await evaluate('document.querySelector("#workSurface").textContent.includes("终端命令产生的文件修改请在「全部」中查看")'), true);
      await evaluate('document.querySelector(".chg-main").click()'); await sleep(180);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
      await shot('web-changes-' + width);
    }
    await evaluate('globalThis.piGuiDesktop={openPath:async()=>({ok:true})}; import("/git.js").then(m=>m.renderChangesBody())');
    assert.equal(await evaluate('[...document.querySelectorAll(".chg-acts button")].some(b=>b.textContent==="打开")'), true);
    await shot('desktop-capability-changes-1200');
    await evaluate('import("/projects.js").then(m=>m.removeProject("C:\\\\pi-GUI"))');
    await sleep(200);
    assert.equal(await evaluate('document.querySelector("#sessionPlans").hidden'), true);
    await evaluate('import("/ui/workspace-surface.js").then(m=>m.showChat())'); await sleep(250);
    for (const [width, height] of [[700, 600], [1200, 800]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await sleep(180);
      const rect = await evaluate('(()=>{const r=document.querySelector("#projectEmptyAdd").getBoundingClientRect();return {width:r.width,height:r.height,top:r.top,bottom:r.bottom}})()');
      assert.ok(rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= height);
      assert.equal(await evaluate('document.querySelector("#input").disabled'), true);
      await shot('empty-project-' + width);
    }
    await evaluate('document.querySelector("#projectEmptyAdd").click()'); await sleep(250);
    assert.equal(await evaluate('!document.querySelector("#modal").hidden && document.querySelector("#modalCard").textContent.includes("选择项目文件夹")'), true);
    await shot('empty-project-picker-1200'); assert.deepEqual(errors, []);
    console.log('6 screenshots; Web/Desktop capability, visible empty CTA, picker, viewport and runtime checks passed');
  } finally { ws?.close(); chrome.kill(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
