/* Native ESM + real Chromium, offline visual fixture; no real Pi or account. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const root = path.resolve(__dirname, '..'), out = path.join(root, '.shots/model-capabilities');
  fs.mkdirSync(out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-capability-chrome-'));
  const port = 18800, cdpPort = 18801, app = `http://127.0.0.1:${port}/`;
  const harness = spawn(process.execPath, [path.join(__dirname, 'visual-harness.cjs')], { cwd: root,
    env: { ...process.env, HARNESS_PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
  const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-sync', '--disable-component-update',
    '--disable-background-networking', '--no-default-browser-check', '--disable-default-apps', '--metrics-recording-only',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  let ws;
  try {
    let pages;
    for (let n = 0; n < 60; n++) { try { pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); if (pages.length && (await fetch(app)).ok) break; } catch {} await sleep(150); }
    ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let seq = 0; const pending = new Map(), errors = [];
    ws.onmessage = event => { const m = JSON.parse(event.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
    const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); const file = path.join(out, name + '.png'); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); console.log(file); };
    const click = async selector => {
      const pos = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...pos });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...pos });
    };
    await send('Page.enable'); await send('Runtime.enable'); await send('Page.navigate', { url: app }); await sleep(1600);
    await evaluate(`(async()=>{ const state=await import('/state.js'); const usage=await import('/usage.js'); const shell=await import('/shell.js');
      globalThis.capFixture={state,usage,shell}; state.S.hasProject=true; state.S.bridgeState='ready'; state.S.switching=false; state.S.modelSwitchPending=false;
      usage.onModels({models:[
        {provider:'fixture',id:'vision',name:'Vision + reasoning',contextWindow:400000,maxTokens:64000,reasoning:true,input:['text','image'],capabilities:{toolCalling:true}},
        {provider:'fixture',id:'text',name:'Text only',contextWindow:128000,reasoning:false,input:['text']},
        {provider:'unknown-provider',id:'unknown',name:'Metadata unavailable'},
      ]});
      usage.applyState({model:state.S.models[0],thinkingLevel:'high'}); usage.onThinkingLevels({levels:['off','low','high']}); shell.applyProjectState(); })()`);
    for (const width of [700, 900, 1200]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
      await click('#btnModel'); await sleep(120);
      if (width === 700) await click('.pop-model-group[data-provider="unknown-provider"] .pop-provider');
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
      const metrics = await evaluate(`(()=>{const p=document.querySelector('.pop'),r=p.getBoundingClientRect();return {width:r.width,right:r.right,top:r.top,bottom:r.bottom,content:p.textContent}})()`);
      assert.ok(metrics.top >= 0 && metrics.right <= width + 1 && metrics.bottom <= 801);
      assert.ok(metrics.content.includes('推理 · 图片 · Tools · 400K'), JSON.stringify(metrics));
      const textRect = await evaluate(`(()=>{const n=document.querySelector('.pop-provider-models .pi-sub'),r=n.getBoundingClientRect();return {width:r.width,height:r.height,scroll:n.scrollWidth,client:n.clientWidth}})()`);
      assert.ok(textRect.width > 0 && textRect.height > 0 && textRect.scroll <= textRect.client + 1);
      await shot('picker-' + width); await click('#btnModel');
    }
    await evaluate(`(()=>{const {state,usage,shell}=capFixture; state.S.attachments=[{id:'image',kind:'image',name:'fixture.png',size:1,dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='}];usage.applyState({model:state.S.models[1],thinkingLevel:'high'});usage.onThinkingLevels({levels:['off']});shell.applyProjectState();})()`);
    assert.equal(await evaluate('document.querySelector("#btnThink").disabled && document.querySelector("#thinkText").textContent==="思考不可用"'), true);
    assert.equal(await evaluate('!document.querySelector("#btnAttach").disabled && document.querySelector("#btnAttach").title.includes("不支持图片") && document.querySelector("#btnSend").disabled'), true);
    assert.equal(await evaluate('document.querySelector("#attachTray").textContent.includes("当前模型不支持图片")'), true);
    await shot('text-model-composer-1200');
    await evaluate(`(()=>{const {state,usage,shell}=capFixture;usage.applyState({model:state.S.models[2],thinkingLevel:'off'});usage.onThinkingLevels({levels:[]});shell.applyProjectState();})()`);
    assert.equal(await evaluate('!document.querySelector("#btnAttach").disabled && !document.querySelector("#btnAttach").title.includes("不支持图片") && !document.querySelector("#btnSend").disabled'), true);
    await shot('unknown-model-composer-1200'); assert.deepEqual(errors, []);
    console.log('5 screenshots; native ESM, real mouse Provider folding, 3 viewport layouts, thinking disabled and image false/unknown verified');
  } finally {
    ws?.close(); chrome.kill(); harness.kill();
    await sleep(500);
    // Only remove the directory created by mkdtemp for this run.
    const resolved = path.resolve(profile), prefix = path.resolve(os.tmpdir()) + path.sep;
    if (resolved.startsWith(prefix) && path.basename(resolved).startsWith('pi-gui-capability-chrome-')) fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
