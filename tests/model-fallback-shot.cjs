/* Native ESM + real Chromium, offline visual fixture; no real Pi or account. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const root = path.resolve(__dirname, '..'), out = path.join(root, '.shots/model-fallback');
  fs.mkdirSync(out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-capability-chrome-'));
  const port = 18810, cdpPort = 18811, app = `http://127.0.0.1:${port}/`;
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

    await evaluate(`(async()=>{const state=await import('/state.js'),usage=await import('/usage.js'),shell=await import('/shell.js'),settings=await import('/project-config.js');
      globalThis.fallbackFixture={state,usage,shell,settings};
      state.S.hasProject=true;state.S.bridgeState='ready';state.S.switching=false;state.S.modelSwitchPending=false;state.S.cwd='fixture';
      usage.onModels({models:[
        {provider:'primary',id:'main',name:'Primary model',input:['text','image'],reasoning:true},
        {provider:'backup',id:'vision',name:'Vision backup with a long readable name',input:['text','image'],contextWindow:200000,reasoning:true},
        {provider:'unknown',id:'other/id',name:'Unknown capability model'},
        {provider:'backup',id:'text',name:'Text model',input:['text'],contextWindow:128000}
      ]});
      usage.applyState({model:state.S.models[0],sessionId:'fixture-session',thinkingLevel:'off'});shell.applyProjectState();
      const originalFetch=window.fetch;window.fetch=(url,options)=>url==='/api/project-config'?Promise.resolve({ok:true,json:async()=>({
        ok:true,hasProject:true,cwd:'fixture',thinkingLevels:['off','low','high'],defaults:{},config:{version:2,model:{provider:'primary',id:'main'},
          fallback:{enabled:true,chain:[{providerId:'backup',modelId:'vision'},{providerId:'unknown',modelId:'other/id'},{providerId:'removed',modelId:'missing'}]}}
      })}):originalFetch(url,options);
      await settings.openProjectSettings();})()`);
    for (const width of [700,900,1200]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await sleep(200);
      const metrics=await evaluate(`(()=>{const card=document.querySelector('#modalCard'),r=card.getBoundingClientRect(),rows=[...card.querySelectorAll('.fallback-row')];return {right:r.right,left:r.left,overflow:document.documentElement.scrollWidth>innerWidth,rows:rows.length,text:card.textContent}})()`);
      assert.ok(metrics.left>=0&&metrics.right<=width+1&&!metrics.overflow);assert.equal(metrics.rows,3);assert.ok(metrics.text.includes('模型不可用'));
      await shot('settings-'+width);
    }
    await evaluate('document.querySelector(".fallback-row .btn").scrollIntoView({block:"center"})');
    await click('.fallback-row .btn:nth-of-type(2)');await sleep(100);
    assert.equal(await evaluate('document.querySelector(".fallback-row").textContent.includes("Unknown capability model")'),true);
    await shot('settings-reordered-1200');
    await evaluate(`(async()=>{const modal=await import('/ui/modal.js');modal.closeModal();const policy=await import('/model-fallback.js'),fallback=await import('/fallback.js'),{state}=fallbackFixture;
      const r=policy.createFallbackRuntime({generation:1,originalModel:{providerId:'primary',modelId:'main'}});
      r.attempt({providerId:'unknown',modelId:'other/id'},policy.classifyGenerationError({message:'429 rate limit',source:'pi-assistant'}),['imageInput']);
      r.confirmed({providerId:'unknown',modelId:'other/id'});
      r.attempt({providerId:'vision',modelId:'image'}, {transitionType:'capability_mismatch',capability:'imageInput'});
      state.S.fallbackRuntime=r.snapshot();state.S.fallbackActive=true;fallback.renderFallbackStatus();document.querySelector('#fallbackStatus').open=true;})()`);
    assert.equal(await evaluate('document.querySelector("#btnStop").hidden'),false);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    await shot('fallback-status-1200');assert.deepEqual(errors,[]);
    console.log('5 screenshots; native ESM project settings, invalid item, real mouse reorder, 3 viewport widths and fallback stop/status verified');
  } finally {
    ws?.close(); chrome.kill(); harness.kill();
    await sleep(500);
    // Only remove the directory created by mkdtemp for this run.
    const resolved = path.resolve(profile), prefix = path.resolve(os.tmpdir()) + path.sep;
    if (resolved.startsWith(prefix) && path.basename(resolved).startsWith('pi-gui-capability-chrome-')) fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
