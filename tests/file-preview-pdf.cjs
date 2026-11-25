'use strict';
// Legal PDF 1.7 objects/xref fixtures; every write stays in os.tmpdir(). No
// downloaded documents, renderer substitutes, model calls or sandbox bypasses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '..');
const local = file => pathToFileURL(path.join(ROOT, 'public', file)).href;
const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();
const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
function rc4(key, value) {
  const s = Array.from({ length: 256 }, (_, i) => i); let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  let i = 0; j = 0;
  return Buffer.from([...value].map(byte => { i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]]; return byte ^ s[(s[i] + s[j]) & 255]; }));
}
function pdfFixture(count = 24, { huge = false, encrypted = false, outline = true, dense = false, active = false } = {}) {
  const objects = [null, '', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const add = value => { objects.push(value); return objects.length - 1; };
  const id = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  let fileKey, owner, user;
  if (encrypted) {
    const padded = password => Buffer.concat([Buffer.from(password), PAD]).subarray(0, 32);
    owner = rc4(md5(padded('owner')).subarray(0, 5), padded('secret'));
    const permissions = Buffer.alloc(4); permissions.writeInt32LE(-4);
    fileKey = md5(padded('secret'), owner, permissions, id).subarray(0, 5);
    user = rc4(fileKey, PAD);
  }
  const pageIds = [];
  for (let index = 1; index <= count; index++) {
    const text = `Page ${index} - literal [a+b].* - searchable local PDF`;
    const content = dense ? Array.from({ length: 21000 }, (_, i) => `BT /F1 ${12 + i % 2} Tf 20 700 Td (word) Tj ET`).join('\n') : `BT /F1 18 Tf 48 700 Td (${text}) Tj 0 -36 Td (Second selectable line ${index}) Tj ET`;
    const streamId = objects.length;
    let stream = Buffer.from(content);
    if (encrypted) { const key = Buffer.alloc(5); key.writeUIntLE(streamId, 0, 3); stream = rc4(md5(fileKey, key).subarray(0, 10), stream); }
    const streamObject = add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]));
    const dimensions = huge ? '0 0 100000 100000' : index === 3 ? '0 0 500 720' : '0 0 612 792';
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [${dimensions}] ${index === 4 ? '/Rotate 90' : ''} /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamObject} 0 R >>`));
  }
  objects[2] = `<< /Type /Pages /Count ${count} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`;
  let outlineId;
  if (outline && !encrypted) {
    outlineId = add('');
    const title = Buffer.from('目录 / Last page', 'utf16le'); title.swap16();
    const item = add(`<< /Title <feff${title.toString('hex')}> /Parent ${outlineId} 0 R ${active ? '/A << /S /URI /URI (https://invalid.example/leak) >>' : `/Dest [${pageIds.at(-1)} 0 R /Fit]`} >>`);
    objects[outlineId] = `<< /Type /Outlines /First ${item} 0 R /Last ${item} 0 R /Count 1 >>`;
  }
  objects[1] = `<< /Type /Catalog /Pages 2 0 R ${outlineId ? `/Outlines ${outlineId} 0 R` : ''} ${active ? '/OpenAction << /S /JavaScript /JS (globalThis.__pdfAttack=true) >>' : ''} >>`;
  const encryption = encrypted ? add(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`) : 0;
  const chunks = [Buffer.from('%PDF-1.7\n%\xff\xff\xff\xff\n', 'latin1')], offsets = [0]; let length = chunks[0].length;
  for (let index = 1; index < objects.length; index++) {
    offsets[index] = length;
    const chunk = Buffer.concat([Buffer.from(`${index} 0 obj\n`), Buffer.isBuffer(objects[index]) ? objects[index] : Buffer.from(objects[index]), Buffer.from('\nendobj\n')]);
    chunks.push(chunk); length += chunk.length;
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] ${encryption ? `/Encrypt ${encryption} 0 R` : ''} >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

async function unitTests(world) {
  const canvas = require('@napi-rs/canvas');
  for (const name of ['DOMMatrix', 'ImageData', 'Path2D']) global[name] = canvas[name];
  // The browser distribution targets newer engines than Node 24. This is a
  // byte-encoding platform shim only, never a PDF parser/renderer replacement.
  if (!Uint8Array.prototype.toHex) Uint8Array.prototype.toHex = function () { return Buffer.from(this).toString('hex'); };
  if (!Map.prototype.getOrInsertComputed) Map.prototype.getOrInsertComputed = function (key, make) { if (!this.has(key)) this.set(key, make(key)); return this.get(key); };
  if (!Map.prototype.getOrInsert) Map.prototype.getOrInsert = function (key, value) { if (!this.has(key)) this.set(key, value); return this.get(key); };
  const pdfjs = await import(local('vendor/file-preview/pdf.js'));
  pdfjs.GlobalWorkerOptions.workerSrc = local('vendor/file-preview/pdf.worker.mjs');
  const { findLiteral, PDF_LIMITS } = await import(local('file-preview/pdf.js'));
  let checks = 0;
  const check = (name, test) => { test(); checks++; console.log('PASS ' + name); };
  check('vendored namespace is genuine PDF.js 6.3.289, no default', () => { assert.equal(pdfjs.version, '6.3.289'); assert.equal(pdfjs.default, undefined); assert.equal(typeof pdfjs.TextLayer, 'function'); });
  check('literal metacharacters are never regex', () => assert.deepEqual(findLiteral('x[a+b].* [a+b].*', '[a+b].*'), [1, 9]));
  check('literal match cap and empty query', () => { assert.equal(findLiteral('aaaaaa', 'a', 3).length, 3); assert.deepEqual(findLiteral('abc', ''), []); });
  check('document, page, aggregate and text budgets are explicit', () => { assert.equal(PDF_LIMITS.bytes, 33554432); assert.equal(PDF_LIMITS.pages, 1200); assert.equal(PDF_LIMITS.pagePixels, 20971520); assert.ok(PDF_LIMITS.residentPages <= 5 && PDF_LIMITS.textPages <= 8); });
  const fixture = pdfFixture(); fs.writeFileSync(path.join(world, 'multipage.pdf'), fixture);
  const load = bytes => pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, useSystemFonts: false, standardFontDataUrl: local('vendor/file-preview/pdf/standard_fonts/') });
  const task = load(fixture), pdf = await task.promise;
  try {
    check('real parser accepts valid xref and all 24 pages', () => assert.equal(pdf.numPages, 24));
    const page = await pdf.getPage(24), text = await page.getTextContent();
    check('real parser extracts actual last-page searchable text', () => assert.ok(text.items.some(item => item.str.includes('Page 24'))));
    check('real literal search operates on actual extracted text', () => assert.equal(findLiteral(text.items.map(item => item.str).join(''), '[a+b].*').length, 1));
    const outline = await pdf.getOutline();
    check('real parser reads Unicode outline and resolves destination', () => assert.equal(outline[0].title, '目录 / Last page'));
    check('outline targets actual last page reference', () => assert.deepEqual(outline[0].dest[0], page.ref));
    const rotated = await pdf.getPage(4), viewport = rotated.getViewport({ scale: 1 });
    check('real rotation/geometry differs from first-page placeholder', () => { assert.equal(viewport.width, 792); assert.equal(viewport.height, 612); });
  } finally { await task.destroy(); }
  const encrypted = pdfFixture(2, { encrypted: true }); fs.writeFileSync(path.join(world, 'encrypted.pdf'), encrypted);
  const locked = load(encrypted);
  try { await assert.rejects(locked.promise, error => error.name === 'PasswordException'); checks++; console.log('PASS actual Standard R2 encrypted PDF requests password'); } finally { await locked.destroy(); }
  const unlocked = pdfjs.getDocument({ data: new Uint8Array(encrypted), password: 'secret', verbosity: 0 });
  try { const doc = await unlocked.promise; check('encrypted fixture really decrypts with correct password', () => assert.equal(doc.numPages, 2)); const page = await doc.getPage(2); const text = await page.getTextContent(); check('encrypted stream is valid actual PDF text', () => assert.ok(text.items.some(item => item.str.includes('Page 2')))); } finally { await unlocked.destroy(); }
  const corrupt = load(Buffer.from('%PDF-1.7\nnot a document'));
  try { await assert.rejects(corrupt.promise, error => error.name === 'InvalidPDFException'); checks++; console.log('PASS real parser rejects corrupt document'); } finally { await corrupt.destroy(); }
  const excessive = load(pdfFixture(1201, { outline: false }));
  try { const doc = await excessive.promise; check('legal 1201-page fixture exceeds policy, not malformed parser input', () => assert.equal(doc.numPages, PDF_LIMITS.pages + 1)); } finally { await excessive.destroy(); }
  console.log(`PDF parser/unit: ${checks}/${checks}; fixture=${fixture.length} bytes; world=${world}`);
}

// Same already-installed Chrome + offline CDP mechanism as Office --browser.
// The harness is private because Office's harness is not exported.
async function chromeHarness(world) {
  const { spawn } = require('node:child_process');
  const WebSocket = require('ws');
  const { EventEmitter } = require('node:events');
  const executable = process.env.PDF_CHROME || process.env.OFFICE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const processHandle = spawn(executable, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + path.join(world, 'chrome-profile'), '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let socket;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => reject(Error('Chrome DevTools unavailable')), 20000);
      processHandle.stderr.on('data', chunk => { text += chunk; const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text); if (match) { clearTimeout(timer); resolve(match[1]); } });
      processHandle.on('error', error => { clearTimeout(timer); reject(error); });
      processHandle.on('exit', code => { clearTimeout(timer); reject(Error('Chrome exited: ' + code)); });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    let sequence = 0; const pending = new Map(), events = new EventEmitter();
    socket.on('close', () => { for (const waiter of pending.values()) waiter.reject(Error('Chrome connection closed')); pending.clear(); });
    socket.on('message', bytes => {
      const message = JSON.parse(String(bytes));
      if (message.id) { const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); message.error ? waiter.reject(Error(message.error.message)) : waiter.resolve(message.result); } }
      else events.emit(message.method, message.params, message.sessionId);
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const command = (method, params) => send(method, params, sessionId);
    await command('Page.enable'); await command('Runtime.enable'); await command('Network.enable');
    const read = async expression => {
      const value = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
      return value.result.value;
    };
    const blocked = [], errors = [];
    events.on('Runtime.exceptionThrown', (event, owner) => { if (owner === sessionId) errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text); });
    events.on('Fetch.requestPaused', (event, owner) => {
      if (owner !== sessionId) return;
      const allowed = /^(http:\/\/127\.0\.0\.1:|blob:|data:)/.test(event.request.url);
      if (!allowed) blocked.push(event.request.url);
      command(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: event.requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}) }).catch(() => {});
    });
    await command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    return { read, command, errors, blocked,
      async navigate(url) { const loaded = new Promise(resolve => events.once('Page.loadEventFired', resolve)); await command('Page.navigate', { url }); await loaded; },
      async close() { await send('Browser.close').catch(() => {}); socket.close(); },
    };
  } catch (error) { socket?.close(); processHandle.kill(); throw error; }
}

async function browserTests(world) {
  const fixtures = { 'multipage.pdf': pdfFixture(), 'huge.pdf': pdfFixture(1, { huge: true }), 'excessive.pdf': pdfFixture(1201), 'encrypted.pdf': pdfFixture(2, { encrypted: true }), 'broken.pdf': Buffer.from('%PDF-1.7\nBROKEN_PRIVATE_PAYLOAD'), 'dense.pdf': pdfFixture(1, { dense: true }), 'no-outline.pdf': pdfFixture(2, { outline: false }), 'active.pdf': pdfFixture(2, { active: true }), 'max-pages.pdf': pdfFixture(1200) };
  for (const [name, bytes] of Object.entries(fixtures)) fs.writeFileSync(path.join(world, name), bytes);
  const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/ui/primitives.css"><style>*{box-sizing:border-box}html,body{margin:0;height:100%;font-family:var(--font-sans);background:var(--ds-bg-primary);color:var(--ds-text-primary)}body{display:flex;flex-direction:column}#toolbar{padding:12px;border-bottom:1px solid var(--ds-border-default)}#host{flex:1;min-height:0}</style></head><body><div id="toolbar"></div><main id="host"></main><script type="module">
  import * as pdfjs from '/vendor/file-preview/pdf.js';
  import {mount,PDF_LIMITS} from '/file-preview/pdf.js';
  const FIXTURES=${JSON.stringify(Object.fromEntries(Object.entries(fixtures).map(([name, bytes]) => [name, bytes.toString('base64')])))};
  const fixtureBytes=name=>Uint8Array.from(atob(FIXTURES[name]),c=>c.charCodeAt(0));
  const NativeWorker=window.Worker, nativeTimeout=window.setTimeout;
  const alive=new WeakSet();window.stats={started:0,terminated:0,renders:0,overlap:0,text:0,layers:0,urls:0,revoked:0,actions:[]};
  window.workerMode='normal';window.stallRender=false;
  const originalURL=URL.createObjectURL.bind(URL), revoke=URL.revokeObjectURL.bind(URL);
  URL.createObjectURL=blob=>{stats.urls++;return originalURL(blob)};URL.revokeObjectURL=url=>{stats.revoked++;return revoke(url)};
  window.Worker=class extends NativeWorker{
    constructor(url,options){const stalled=window.workerMode==='stall';const owned=stalled?URL.createObjectURL(new Blob(['for(;;){}'],{type:'text/javascript'})):null;super(owned||url,options);stats.started++;this.done=false;this.owned=owned}
    postMessage(data,...args){stats.actions.push(data.action||'reply');if(data.action==='GetDocRequest')stats.requestBytes=data.data?.data?.byteLength;if(window.stallRender&&data.action==='GetOperatorList')return;return super.postMessage(data,...args)}
    terminate(){if(!this.done){stats.terminated++;this.done=true;if(this.owned)URL.revokeObjectURL(this.owned)}return super.terminate()}
  };
  // PDFPageProxy is intentionally not exported in 6.3: discover the actual
  // prototype from a genuine parsed page, then wrap/delegate, never fake it.
  const samplePort=new Worker('/vendor/file-preview/pdf.worker.mjs',{type:'module'}),sampleWorker=new pdfjs.PDFWorker({port:samplePort,verbosity:0});
  const sampleBytes=fixtureBytes('multipage.pdf');
  window.bootstrapInfo={version:pdfjs.version,agent:navigator.userAgent,received:sampleBytes.length,head:[...sampleBytes.subarray(0,5)]};
  const sampleTask=pdfjs.getDocument({data:sampleBytes,worker:sampleWorker,verbosity:0});
  sampleTask.promise.catch(error=>{window.bootstrapError={name:error.name,message:error.message,details:error.details}});
  const sampleDoc=await sampleTask.promise, pagePrototype=Object.getPrototypeOf(await sampleDoc.getPage(1));
  await sampleTask.destroy();sampleWorker.destroy();samplePort.terminate();
  const render=pagePrototype.render;
  pagePrototype.render=function(options){stats.renders++;const canvas=options.canvas||options.canvasContext.canvas;if(alive.has(canvas))stats.overlap++;alive.add(canvas);const task=render.call(this,options);task.promise.finally(()=>alive.delete(canvas)).catch(()=>{});return task};
  const stream=pagePrototype.streamTextContent;
  pagePrototype.streamTextContent=function(...args){stats.text++;return stream.apply(this,args)};
  const layer=pdfjs.TextLayer.prototype.render;pdfjs.TextLayer.prototype.render=function(...args){stats.layers++;return layer.apply(this,args)};
  window.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,window.workerMode==='stall'&&ms===PDF_LIMITS.parseMs?150:window.stallRender&&ms===PDF_LIMITS.renderMs?150:ms,...args);
  window.cleanup=()=>{};window.lastError='';
  window.showFixture=async(name,state={})=>{
    cleanup();document.querySelector('#toolbar').replaceChildren();document.querySelector('#host').replaceChildren();window.lastError='';
    const abort=new AbortController(),owned=[];let current=true,view;
    const ctx={host:document.querySelector('#host'),toolbar:document.querySelector('#toolbar'),state,request:{name},meta:{name},resources:{signal:abort.signal,isCurrent:()=>current,own:fn=>owned.push(fn)},access:{bytes:async max=>{if(name==='oversize.pdf')return new Uint8Array(max+1);const bytes=fixtureBytes(name);if(bytes.length>max)throw Error('limit');return bytes}},error:message=>{window.lastError=message;ctx.host.textContent=message}};
    window.abortView=()=>abort.abort();
    window.cleanup=()=>{if(!current)return;current=false;abort.abort();view?.dispose();for(const fn of owned.reverse())fn()};
    view=await mount(ctx);window.currentView=view;return {error:window.lastError,state:view.getState()};
  };
  window.pageTo=page=>{const input=document.querySelector('.fp-pdf-page-input');input.value=String(page);input.dispatchEvent(new Event('change'))};
  window.searchFor=value=>{const input=document.querySelector('.fp-search');input.value=value;input.dispatchEvent(new Event('input'))};
  window.until=async(test,ms=10000)=>{const until=performance.now()+ms;while(!test()){if(performance.now()>until)throw Error('condition timeout: '+String(test));await new Promise(resolve=>nativeTimeout(resolve,20))}};
  window.painted=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  window.contrastFor=selector=>{const el=document.querySelector(selector),ctx=document.createElement('canvas').getContext('2d',{willReadFrequently:true});ctx.canvas.width=ctx.canvas.height=1;const chain=[];for(let n=el;n;n=n.parentElement)chain.unshift(n);ctx.fillStyle='#fff';ctx.fillRect(0,0,1,1);for(const n of chain){ctx.fillStyle=getComputedStyle(n).backgroundColor;ctx.fillRect(0,0,1,1)}const bg=[...ctx.getImageData(0,0,1,1).data].slice(0,3);ctx.fillStyle=getComputedStyle(el).color;ctx.fillRect(0,0,1,1);const fg=[...ctx.getImageData(0,0,1,1).data].slice(0,3);const lum=rgb=>rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);const a=lum(fg),b=lum(bg);return{fg,bg,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)}};
  window.fixtureReady=true;
  </script></body></html>`;
  const requests = [], publicRoot = path.join(ROOT, 'public');
  const server = require('node:http').createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1'); requests.push(url.pathname);
    if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
    if (url.pathname.startsWith('/fixture/')) { const bytes = fixtures[url.pathname.slice(9)]; response.writeHead(bytes ? 200 : 404, { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Length': bytes?.length || 0, 'Cache-Control': 'no-store' }); response.end(bytes || ''); return; }
    const file = path.resolve(publicRoot, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.wasm') ? 'application/wasm' : /\.(js|mjs)$/.test(file) ? 'text/javascript' : 'application/octet-stream'); response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, checks = 0; const screenshots = [], measurements = [];
  const check = (name, success) => { assert.ok(success, name); checks++; console.log('PASS ' + name); };
  try {
    browser = await chromeHarness(world);
    const { read, command } = browser;
    const watchdog = setTimeout(() => { console.error('PDF browser watchdog expired'); process.exitCode = 1; browser.close().finally(() => server.close()); }, 180000);
    try {
      await browser.navigate('http://127.0.0.1:' + server.address().port);
      await read('new Promise((resolve,reject)=>{const end=performance.now()+15000;const tick=()=>window.fixtureReady?resolve():performance.now()>end?reject(Error("fixture module failed")):setTimeout(tick,20);tick()})');
      for (const [width, height] of [[1320, 820], [700, 600]]) for (const theme of ['light', 'dark']) {
        await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        const mounted = await read('showFixture("multipage.pdf")');
        if (!mounted.error) await read('painted().then(()=>until(()=>document.querySelector("[data-page=\\"1\\"] .fp-pdf-text-layer")?.textContent.includes("Page 1"))).then(painted).then(()=>until(()=>document.querySelector("[data-page=\\"1\\"] .fp-pdf-text-layer")?.textContent.includes("Page 1")))');
        check(`real multipage PDF.js render/TextLayer ${width} ${theme}`, !mounted.error && await read('document.querySelectorAll(".fp-pdf-page").length===24&&document.querySelector(".fp-pdf-text-layer").textContent.includes("Page 1")'));
        await read('painted()');
        const geometry = await read(`(()=>{const span=document.querySelector('.fp-pdf-text-layer span'),r=span.getBoundingClientRect(),p=span.closest('article').getBoundingClientRect();return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,span:{x:r.x,y:r.y,w:r.width,h:r.height},page:{x:p.x,y:p.y,w:p.width,h:p.height},toolbar:document.querySelector('#toolbar').scrollWidth,fit:currentView.getState(),input:getComputedStyle(document.querySelector('.fp-search')).color,inputBg:getComputedStyle(document.querySelector('.fp-search')).backgroundColor,status:getComputedStyle(document.querySelector('.fp-pdf-status')).color,statusBg:getComputedStyle(document.querySelector('.fp-pdf')).backgroundColor}})()`);
        measurements.push({ theme, ...geometry });
        check(`selectable TextLayer has real aligned geometry ${width} ${theme}`, geometry.span.w > 100 && geometry.span.h > 8 && geometry.span.x >= geometry.page.x && geometry.span.y >= geometry.page.y && geometry.span.y < geometry.page.y + geometry.page.h);
        check(`toolbar wraps within viewport ${width} ${theme}`, geometry.toolbar <= width);
        const contrast = await read('({input:contrastFor(".fp-search"),status:contrastFor(".fp-pdf-status"),button:contrastFor("button[aria-label=适合宽度]")})');
        measurements.at(-1).contrast = contrast;
        check(`rendered enabled control/status text contrast AA ${width} ${theme}`, Object.values(contrast).every(item => item.ratio >= 4.5));
        await read(`(()=>{const span=document.querySelector('.fp-pdf-text-layer span');const range=document.createRange();range.selectNodeContents(span);getSelection().removeAllRanges();getSelection().addRange(range)})()`);
        check(`real browser selection exposes actual text ${width} ${theme}`, (await read('getSelection().toString()')).includes('Page 1'));
        const image = await command('Page.captureScreenshot', { format: 'png' });
        const file = path.join(world, `pdf-${width}-${theme}.png`); fs.writeFileSync(file, Buffer.from(image.data, 'base64')); screenshots.push(file);
      }
      // Native CDP input, not only dispatched JS events: keyboard navigation,
      // Enter-to-jump, pointer hover/press, wheel and focus-visible semantics.
      const key = async (name, code, vk, modifiers = 0) => {
        for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode: vk, modifiers });
      };
      await read('getSelection().removeAllRanges();document.querySelector(".fp-pdf-page-input").focus()');
      await key('Tab', 'Tab', 9);
      check('real Tab reaches zoom control with visible keyboard focus', await read('document.activeElement.getAttribute("aria-label")==="缩小"&&document.activeElement.matches(":focus-visible")&&getComputedStyle(document.activeElement).outlineStyle!=="none"'));
      await key('Tab', 'Tab', 9, 8);
      await key('a', 'KeyA', 65, 2); await command('Input.insertText', { text: '3' }); await key('Enter', 'Enter', 13);
      await read('until(()=>currentView.getState().page===3&&document.querySelector("[data-page=\\"3\\"] .fp-pdf-text-layer")?.textContent.includes("Page 3"))');
      check('real Shift+Tab and Enter jump to mixed-size page 3', await read('Number(document.querySelector(".fp-pdf-page-input").value)===3'));
      const pointer = await read('(()=>{const r=document.querySelector("button[aria-label=放大]").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,zoom:currentView.getState().zoom}})()');
      await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointer.x, y: pointer.y });
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x: pointer.x, y: pointer.y });
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: pointer.x, y: pointer.y });
      check('real pointer click zooms without fake keyboard focus ring', await read(`currentView.getState().zoom>${pointer.zoom}&&!document.activeElement.matches(':focus-visible')`));
      await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 350, y: 350, deltaY: 1200, deltaX: 0 });
      await read('until(()=>currentView.getState().page>3)');
      check('native wheel advances continuous document reading page', await read('currentView.getState().page>=4'));
      for (const theme of ['light', 'dark']) {
        await read('pageTo(1);document.querySelector("button[aria-label=适合宽度]").click();until(()=>document.querySelector("[data-page=\\"1\\"] .fp-pdf-text-layer")?.textContent.includes("Page 1")).then(painted)');
        await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)};for(const [label,text] of [['缩小','Zoom out'],['放大','Zoom in'],['适合宽度','Fit page width / 适合页面宽度'],['上一个匹配项','Previous match / 上一处'],['下一个匹配项','Next match / 下一处']])document.querySelector('button[aria-label="'+label+'"]').textContent=text;painted()`);
        check(`narrow long English/Chinese control labels fit ${theme}`, await read('[...document.querySelectorAll(".fp-pdf-tools button")].every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})'));
        check(`portrait fit remains in viewport after discovering landscape page ${theme}`, await read('(()=>{const r=document.querySelector("[data-page=\\"1\\"]").getBoundingClientRect(),s=document.querySelector(".fp-pdf-scroll").getBoundingClientRect();return r.left>=s.left&&r.right<=s.right})()'));
        const image = await command('Page.captureScreenshot', { format: 'png' });
        const file = path.join(world, `pdf-700-${theme}-english.png`); fs.writeFileSync(file, Buffer.from(image.data, 'base64')); screenshots.push(file);
      }
      await read('showFixture("multipage.pdf")');
      await read('pageTo(12);until(()=>document.querySelector("[data-page=\\"12\\"] .fp-pdf-text-layer")?.textContent.includes("Page 12"))');
      check('page jump/count point to actual page 12', await read('currentView.getState().page===12&&document.querySelector(".fp-pdf-total").textContent.includes("24")'));
      check('outline visible only when supplied by real parser', await read('!document.querySelector(".fp-pdf-outline").hidden&&document.querySelector(".fp-pdf-outline").textContent.includes("目录")'));
      await read('document.querySelector(".fp-pdf-outline").value="1";document.querySelector(".fp-pdf-outline").dispatchEvent(new Event("change"));until(()=>document.querySelector("[data-page=\\"24\\"] .fp-pdf-text-layer")?.textContent.includes("Page 24"))');
      check('outline resolves genuine destination to last page', await read('currentView.getState().page===24'));
      await read('searchFor("[a+b].*");until(()=>document.querySelector(".fp-pdf-match-count").textContent==="1/24")');
      check('literal metacharacters search across all pages', await read('currentView.getState().page===1'));
      await read('document.querySelector("button[aria-label=下一个匹配项]").click();until(()=>currentView.getState().page===2)');
      check('next matching occurrence jumps page', await read('document.querySelector(".fp-pdf-match-count").textContent==="2/24"'));
      await read('searchFor("NOT_FOUND");searchFor("Page 21 -");until(()=>document.querySelector(".fp-pdf-match-count").textContent==="1/1")');
      check('rapid search change discards stale result, jumps page 21', await read('currentView.getState().page===21'));
      await read('until(()=>document.querySelector("[data-page=\\"21\\"] .has-search-hit"))');
      const before = await read('stats.renders');
      await read('for(let i=0;i<30;i++)document.querySelector(".fp-pdf-scroll").dispatchEvent(new Event("scroll"));painted()');
      check('repeated scroll does not rerender ready canvas', (await read('stats.renders')) <= before + 1);
      await read('searchFor("");document.querySelector("button[aria-label=放大]").click();painted()');
      check('zoom updates state and disables fit', await read('!currentView.getState().fitWidth'));
      await read('document.querySelector("button[aria-label=适合宽度]").click();painted()');
      check('fit awaits real page geometry rather than reading Promise', await read('currentView.getState().fitWidth&&Number.isFinite(currentView.getState().zoom)'));
      for (const page of [1, 4, 8, 12, 18, 24, 1]) {
        await read(`pageTo(${page});until(()=>document.querySelector('[data-page="${page}"] .fp-pdf-text-layer')?.textContent.includes('Page ${page}')).then(painted)`);
        const resident = await read('({canvases:document.querySelectorAll(".fp-pdf-canvas").length,layers:document.querySelectorAll(".fp-pdf-text-layer").length,pixels:[...document.querySelectorAll(".fp-pdf-canvas")].reduce((n,c)=>n+c.width*c.height,0)})');
        check(`bounded canvas/text residency after page ${page}`, resident.canvases <= 5 && resident.layers <= 5 && resident.pixels <= 24 * 1024 * 1024);
      }
      check('no concurrent render task ever shares a canvas', (await read('stats.overlap')) === 0);
      check('many real parser text streams exercise cache eviction', (await read('stats.text')) > 30);
      const saved = await read('pageTo(16);until(()=>currentView.getState().page===16).then(()=>currentView.getState())');
      await read(`showFixture('multipage.pdf',${JSON.stringify(saved)})`);
      check('tab restore retains reading page/zoom', await read('currentView.getState().page===16'));
      await command('Emulation.setDeviceMetricsOverride', { width: 700, height: 600, deviceScaleFactor: 2, mobile: false });
      const largeZoom = await read('showFixture("multipage.pdf",{zoom:4,fitWidth:false})');
      check('400% zoom at DPR 2 lowers backing resolution within 20 Mi pixels', !largeZoom.error && await read('document.querySelector(".fp-pdf-canvas").width*document.querySelector(".fp-pdf-canvas").height<=20*1024*1024&&currentView.getState().zoom===4'));
      await command('Emulation.setDeviceMetricsOverride', { width: 700, height: 600, deviceScaleFactor: 1, mobile: false });
      const active = await read('showFixture("active.pdf")');
      check('PDF OpenAction JavaScript and external URI outline remain inert', !active.error && await read('window.__pdfAttack===undefined&&document.querySelector(".fp-pdf-outline").hidden&&!document.querySelector("#host iframe,#host script,#host a")'));
      const pagesBefore = await read('stats.actions.filter(x=>x==="GetPage").length');
      const maxPages = await read('showFixture("max-pages.pdf",{page:1200,zoom:1,fitWidth:false})');
      check('exact 1200-page limit accepts and renders actual last page', !maxPages.error && await read('document.querySelectorAll(".fp-pdf-page").length===1200&&document.querySelector("[data-page=\\"1200\\"] .fp-pdf-text-layer")?.textContent.includes("Page 1200")'));
      check('1200-page open does not eagerly request every page', (await read('stats.actions.filter(x=>x==="GetPage").length')) - pagesBefore <= 4);
      for (const [name, phrase] of [['no-outline.pdf', ''], ['encrypted.pdf', '加密'], ['broken.pdf', '损坏'], ['oversize.pdf', '预算'], ['excessive.pdf', '预算'], ['huge.pdf', '预算'], ['dense.pdf', '预算']]) {
        const result = await read(`showFixture(${JSON.stringify(name)})`);
        check(name + ' controlled outcome', phrase ? result.error.includes(phrase) && result.error.length < 70 && !result.error.includes('PRIVATE') : !result.error && await read('document.querySelector(".fp-pdf-outline").hidden'));
      }
      await read('window.workerMode="stall";showFixture("multipage.pdf")');
      check('hung real worker hits parse deadline and short error', await read('lastError.includes("超时")'));
      await read('window.workerMode="normal";window.stallRender=true;showFixture("multipage.pdf")');
      check('blocked real operator-list stream hits render deadline', await read('lastError.includes("超时")'));
      await read('(async()=>{window.stallRender=false;window.workerMode="stall";const before=stats.started;window.pendingMount=showFixture("multipage.pdf");await until(()=>stats.started>before);abortView();await pendingMount})()');
      check('abort during actual native worker startup returns promptly', await read('!document.querySelector(".fp-pdf")&&!lastError'));
      await read('(async()=>{window.workerMode="normal";window.stallRender=true;const before=stats.actions.filter(x=>x==="GetOperatorList").length;window.pendingMount=showFixture("multipage.pdf");await until(()=>stats.actions.filter(x=>x==="GetOperatorList").length>before);abortView();await pendingMount;window.stallRender=false})()');
      check('abort cancels an actual in-flight canvas render before deadline', await read('!document.querySelector(".fp-pdf")&&!lastError'));
      await read('window.workerMode="normal";showFixture("multipage.pdf")');
      await read('abortView();cleanup();until(()=>stats.started===stats.terminated)');
      const stats = await read('stats');
      check('all real workers terminated after error/abort/tab switch', stats.started >= 10 && stats.started === stats.terminated);
      check('all object URLs released, normal PDF makes none', stats.urls === stats.revoked);
      check('dispose removes plugin-owned DOM and controls', await read('!document.querySelector(".fp-pdf,.fp-pdf-tools")'));
      check('no remote network request attempted', browser.blocked.length === 0);
      check('no uncaught exception from cancelled/late work', browser.errors.length === 0);
      const evidence = { checks, screenshots, measurements, stats, requests: [...new Set(requests)], blocked: browser.blocked, errors: browser.errors, sandboxBypass: false, sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'public/file-preview/pdf.js'))).digest('hex') };
      fs.writeFileSync(path.join(world, 'evidence.json'), JSON.stringify(evidence, null, 2));
      console.log(`PDF Chrome: ${checks}/${checks}; screenshots=${screenshots.length}; workers=${stats.started}/${stats.terminated}; renders=${stats.renders}; text=${stats.text}; evidence=${world}`);
    } finally { clearTimeout(watchdog); }
  } catch (error) { console.error('Browser exceptions:', browser?.errors); if (browser) console.error(await browser.read('({bootstrapInfo:window.bootstrapInfo,bootstrapError:window.bootstrapError,lastError:window.lastError,stats:window.stats})').catch(() => ({}))); console.error('Requests:', requests); throw error; }
  finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}

module.exports = { pdfFixture };
if (require.main === module) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pdf-test-'));
  (process.argv.includes('--browser') ? browserTests(world) : unitTests(world)).catch(error => { console.error(error); console.error('PDF fixtures/evidence: ' + world); process.exitCode = 1; });
}
