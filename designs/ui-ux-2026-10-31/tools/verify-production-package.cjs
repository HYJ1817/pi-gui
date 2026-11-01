'use strict';
// Actual packaged executable + bundled renderer, against owned offline fixtures.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const build = path.resolve(process.env.DESIGN_PACKAGE_BUILD_ROOT || fs.readFileSync(path.join(__dirname, '../evidence/production-build-final-path.txt'), 'utf8').trim());
const appDir = path.join(build, 'dist-app/Pi GUI-win32-x64');
const assets = path.join(appDir, 'resources/app/public');
const out = path.resolve(process.env.DESIGN_PACKAGE_OUTPUT_ROOT || path.resolve(__dirname, '../evidence/production-package'));
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-refined-package-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const facts = { fixture: 'actual packaged executable, bundled renderer/preload; existing offline visual harness; TEMP user data; not production backend E2E', checks: [], assets: [], screenshots: [], errors: [] };
let harness, proxy, child, socket, send;
const check = (name, value) => { facts.checks.push({ name, ok: Boolean(value) }); if (!value) throw Error(name); };
function files(dir, prefix = '') { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name), prefix + e.name + '/') : [prefix + e.name]); }
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function main() {
  fs.mkdirSync(out, { recursive: true });
  for (const file of files(path.join(root, 'public'))) {
    const digest = sha(path.join(root, 'public', file));
    const match = fs.existsSync(path.join(assets, file)) && digest === sha(path.join(assets, file));
    facts.assets.push({ file, digest, match });
  }
  check('all packaged renderer assets match final source', facts.assets.every(a => a.match));
  harness = spawn(process.execPath, [path.join(root, 'tests/visual-harness.cjs')], { cwd: world, windowsHide: true,
    env: { ...process.env, HARNESS_PORT: '0', VISUAL_PUBLIC_ROOT: assets, VISUAL_UPLOAD_DIR: path.join(world, 'uploads') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = await new Promise((resolve, reject) => { let text = ''; const timer = setTimeout(() => reject(Error('harness timeout')), 15000); harness.stdout.on('data', b => { text += b; const m = text.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); resolve(m[0]); } }); });
  proxy = http.createServer((req, res) => {
    if (req.url === '/api/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ app: 'pi-gui', protocol: 1, version: require(path.join(root, 'package.json')).version })); }
    const up = http.request(origin + req.url, { method: req.method, headers: { ...req.headers, host: new URL(origin).host } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up); res.on('close', () => up.destroy());
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const cdpPort = probe.address().port; await new Promise(r => probe.close(r));
  const appOrigin = 'http://127.0.0.1:' + proxy.address().port;
  const env = { ...process.env, PORT: String(proxy.address().port), PI_GUI_DATA: path.join(world, 'data'), PI_GUI_LOG_DIR: path.join(world, 'logs'), PI_GUI_OFFLINE: '1',
    HOME: path.join(world, 'home'), USERPROFILE: path.join(world, 'home'), APPDATA: path.join(world, 'appdata'), LOCALAPPDATA: path.join(world, 'localappdata') };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(path.join(appDir, 'Pi GUI.exe'), ['--user-data-dir=' + path.join(world, 'profile'), '--remote-debugging-port=' + cdpPort], { cwd: world, env, windowsHide: true, stdio: 'ignore' });
  let page;
  for (let n = 0; n < 150; n++) { try { page = (await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()).find(p => p.type === 'page' && p.url.startsWith(appOrigin)); if (page) break; } catch {} if (child.exitCode !== null) throw Error('packaged app exited before target'); await sleep(100); }
  if (!page) throw Error('owned packaged target unavailable');
  socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
  let id = 0; const pending = new Map();
  socket.onmessage = event => { const m = JSON.parse(event.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  send = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; const timer = setTimeout(() => { pending.delete(key); reject(Error('CDP timeout: ' + method)); }, 15000); pending.set(key, m => { clearTimeout(timer); m.error ? reject(Error(m.error.message)) : resolve(m.result); }); socket.send(JSON.stringify({ id: key, method, params })); });
  const read = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.text); return r.result?.value; };
  for (let n = 0; n < 100 && !await read(`Boolean(document.getElementById('btnWorkPanel')&&document.querySelector('.pj-sess'))`); n++) await sleep(100);
  facts.runtime = await read(`({ua:navigator.userAgent,desktop:Boolean(window.piGuiDesktop?.browser),width:innerWidth,height:innerHeight,dpr:devicePixelRatio,theme:document.documentElement.dataset.theme})`);
  check('real packaged desktop preload and Electron renderer', facts.runtime.desktop && /Electron\//.test(facts.runtime.ua));
  check('single sidebar and real model search render from bundled assets', await read(`document.getElementById('globalRail').hidden&&Math.abs(document.getElementById('projectSidebar').getBoundingClientRect().width-264)<1`));
  const shot = async name => { await send('Page.bringToFront'); await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await sleep(150); const image = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64')); facts.screenshots.push(name + '.png'); };
  await shot('packaged-empty');
  await read(`document.getElementById('btnModel').click()`);
  check('bundled model search is reachable', await read(`Boolean(document.querySelector('.ui3-model-search'))`)); await shot('packaged-model');
  await read(`document.getElementById('btnModel').focus();document.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));document.getElementById('navGlobalMore').click()`);
  check('bundled Settings opens real workspace surface', await read(`document.getElementById('workspace').dataset.workspaceView==='settings'`)); await shot('packaged-settings');
  if (process.env.DESIGN_PACKAGE_BUILD_ROOT) {
    await read(`document.getElementById('navAppearance').click()`);
    check('bundled Settings detail uses central form and keeps modal separate', await read(`document.getElementById('modal').hidden&&!!document.querySelector('#workSurface .settings-detail-card select')`));
    await shot('packaged-settings-appearance');
    check('bundled Runtime includes dedicated Refined stylesheet', await read(`!![...document.styleSheets].find(sheet=>sheet.href?.endsWith('/runtime-conversation.css'))`));
  }
  await send('Browser.close').catch(() => {});
}
main().catch(error => { facts.errors.push(error.stack); process.exitCode = 1; }).finally(async () => {
  socket?.close(); if (child?.exitCode === null) { await sleep(500); if (child.exitCode === null) child.kill(); }
  harness?.kill(); proxy?.closeAllConnections(); proxy?.close();
  fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ checks: facts.checks.length, failures: facts.checks.filter(c => !c.ok).length, assets: facts.assets.length, screenshots: facts.screenshots.length, errors: facts.errors }));
});
