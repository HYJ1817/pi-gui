// Offline real-Chrome evidence for the two reconciled expectations.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const out = __dirname;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-cdp-palette-'));
const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-sync',
  '--disable-background-networking', '--disable-component-update', '--remote-debugging-port=19238',
  '--user-data-dir=' + profile, '--window-size=1440,900', 'about:blank'
], { stdio: 'ignore' });
let ws;
(async () => {
  let target;
  for (let n = 0; n < 60 && !target; n++) {
    await sleep(200);
    try { target = (await (await fetch('http://127.0.0.1:19238/json/list')).json()).find(t => t.type === 'page'); } catch {}
  }
  assert.ok(target, 'Chrome page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const pending = new Map(); let id = 0;
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  const send = (method, params = {}) => new Promise(resolve => {
    const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params }));
  });
  const run = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!r.result.exceptionDetails, JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };
  await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:18793/' });
  for (let n = 0; n < 60; n++) {
    await sleep(100);
    if (await run('!!document.querySelector("#projects .project.active .pj-row-menu-trigger")')) break;
  }
  await sleep(700);
  const source = fs.readFileSync(path.resolve(__dirname, '../../../../tests/cdp-shot.cjs'), 'utf8');
  const start = source.indexOf('const headStable = ' + String.fromCharCode(96));
  const end = source.indexOf(String.fromCharCode(96) + ';', start);
  const literal = source.slice(start + 'const headStable = '.length, end + 1);
  const headStable = Function('return ' + literal)();
  const builtinLine = source.split('\n').find(line => line.includes("['built-in 只显示已安装状态"));
  const builtin = Function('return ' + builtinLine.slice(builtinLine.indexOf(String.fromCharCode(96)), builtinLine.lastIndexOf(String.fromCharCode(96)) + 1))();
  const barStart = source.indexOf('const barStyleOk = ');
  const barEnd = source.indexOf('const scrollableOk = ', barStart);
  const barStyleOk = Function('return ' + source.slice(barStart + 'const barStyleOk = '.length, barEnd).trim().replace(/;$/, ''))();
  const results = [];
  for (const mode of ['dark', 'light']) {
    await run('(async()=>{const t=await import("/theme.js");return t.setThemePreference("' + mode + '")})()');
    await sleep(300);
    await run('document.querySelector("#projects .project.active .pj-row-menu-trigger").click()');
    await sleep(200);
    const head = await run(headStable);
    assert.equal(head, true, mode + ' headStable: ' + head);
    const menu = await run('JSON.stringify([...document.querySelectorAll("#actionMenu [role=menuitem]")].map(x=>x.textContent.trim()))');
    assert.equal(menu, JSON.stringify(['工作区管理', '项目设置', '移除项目']));
    const computed = await run('({theme:document.documentElement.dataset.theme,background:getComputedStyle(document.querySelector(".stage-head")).backgroundColor,token:getComputedStyle(document.documentElement).getPropertyValue("--titlebar").trim(),menuRole:document.querySelector("#actionMenu").getAttribute("role"),separatorCount:document.querySelectorAll("#actionMenu [role=separator]").length})');
    assert.equal(computed.menuRole, 'menu');
    assert.equal(computed.separatorCount, 1);
    const capture = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, mode + '-titlebar-project-menu.png'), Buffer.from(capture.result.data, 'base64'));
    // Negative controls prove each strict palette comparison rejects a wrong value.
    await run('document.querySelector(".stage-head").style.backgroundColor="#0d0d0d"');
    const wrongBackground = await run(headStable);
    assert.equal(wrongBackground, '背景色不对：rgb(13, 13, 13)');
    await run('document.querySelector(".stage-head").style.removeProperty("background-color");document.documentElement.style.setProperty("--titlebar","#0d0d0d");document.querySelector(".stage-head").style.backgroundColor="' + computed.background + '"');
    const wrongToken = await run(headStable);
    assert.equal(wrongToken, '--titlebar 不是 electron overlay 的颜色：#0d0d0d');
    await run('document.querySelector(".stage-head").style.removeProperty("background-color");document.documentElement.style.removeProperty("--titlebar");document.body.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');
    const bar = await run(barStyleOk('.stage-head'));
    assert.equal(bar, true, mode + ' scrollbar: ' + bar);
    await run('document.querySelector(".stage-head").style.setProperty("--ui-scrollbar","#2c2c2c")');
    await sleep(100);
    const wrongScrollbar = await run(barStyleOk('.stage-head'));
    assert.equal(wrongScrollbar, '滑块不符合主题：rgb(44, 44, 44)');
    await run('document.querySelector(".stage-head").style.removeProperty("--ui-scrollbar");document.documentElement.style.setProperty("--ui-scrollbar","#2c2c2c")');
    await sleep(100);
    assert.equal(await run(barStyleOk('.stage-head')), '滚动条 Token 不符合主题');
    await run('document.documentElement.style.removeProperty("--ui-scrollbar");document.querySelector("#navExtensions").click()');
    await sleep(300);
    await run('document.querySelector("#extensionsTabAll").click()');
    await sleep(300);
    await run('[...document.querySelectorAll("#workSurface .cap-view .ext-item")].find(n=>n.textContent.includes("builtin:mcp")).click()');
    await sleep(200);
    assert.equal(await run(builtin), true, 'exact builtin fields and source');
    const capCapture = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, mode + '-builtin-fields.png'), Buffer.from(capCapture.result.data, 'base64'));
    for (const key of ['启用配置', '已加载']) {
      await run('(()=>{const r=document.createElement("div");r.id="negativeBuiltin";r.className="ext-row";r.dataset.k=' + JSON.stringify(key) + ';r.innerHTML=\'<span class="ext-row-v">不适用</span>\';document.querySelector("#workSurface .cap-rows").appendChild(r)})()');
      assert.equal(await run(builtin), false, 'reject invented ' + key);
      await run('document.querySelector("#negativeBuiltin").remove()');
    }
    await run('[...document.querySelectorAll("#workSurface .ext-sec-head")].find(x=>x.textContent==="来源").textContent="negative-source"');
    assert.equal(await run(builtin), false, 'reject missing source');
    await run('document.querySelector("#navHome").click()');
    results.push({ ...computed, headStable: head, menu: JSON.parse(menu), wrongBackground, wrongToken, wrongScrollbar, builtinNegativeFields: ['启用配置','已加载','missing source'], checks: 13 });
  }
  fs.writeFileSync(path.join(out, 'palette-menu-results.json'), JSON.stringify({ checks: 26, passed: 26, failed: 0, results }, null, 2));
  console.log('Palette/menu/builtin/scrollbar audit: 26/26 passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { ws?.close(); chrome.kill(); });
