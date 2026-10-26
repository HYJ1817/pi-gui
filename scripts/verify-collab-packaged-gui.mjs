// Opt-in Windows packaged-window qualification. Reuses candidate-pi and the
// Z4 offline guard. No installer, model, real project or application data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2], osInput = process.argv.includes('--os-input');
assert.ok(process.platform === 'win32' && output && path.isAbsolute(output), 'usage: node scripts/verify-collab-packaged-gui.mjs <absolute evidence directory>');
const exe = path.join(root, 'dist-app/Pi GUI-win32-x64/Pi GUI.exe');
assert.ok(fs.existsSync(exe), 'build independent App first');
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'z46b-packaged-gui-'));
const repo = path.join(world, 'repo'), data = path.join(world, 'data'), home = path.join(world, 'home');
const guard = path.join(root, 'tests/fixtures/z4-offline-network.cjs');
const report = { qualification: 'packaged-gui-fake-pi', startedAt: new Date().toISOString(), checks: [], failed: 0, screenshots: [], launches: [], modelCalls: 0,
  input: 'Chromium CDP Input dispatch; optional Windows Computer Use SendInput smoke recorded separately; not physical hardware input',
  limits: ['fake Pi, not real model', 'test preload guard is not an OS network sandbox', 'no installation or upgrade qualification'] };
let child, ui, main, proxy, stage = 'setup';
const observed = [];
const sockets = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (name, pass) => { assert.ok(pass, name); report.checks.push(name); console.log('ok ' + name); };
async function until(fn, name, ms = 20000) {
  stage = name;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return; await sleep(70); }
  throw Error('verification_timeout');
}
async function port() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function json(url) { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).json(); }
async function connect(url) {
  const ws = new WebSocket(url), pending = new Map(), events = []; let id = 0;
  sockets.add(ws);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(Error('debug_socket_timeout')); }, 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(Error('debug_socket_failed')); };
  });
  ws.onmessage = event => { const value = JSON.parse(event.data); if (value.method) events.push(value.method); pending.get(value.id)?.(value); };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    report.lastDebugCommand = { method, awaitPromise: Boolean(params.awaitPromise), pausedObserved: events.includes('Debugger.paused') };
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error('debug_command_timeout')); }, 15000);
    pending.set(requestId, value => { clearTimeout(timer); pending.delete(requestId); value.error ? reject(Error('debug_command_failed')) : resolve(value.result); });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  return { send, events, read: async (expression, awaitPromise = true) => {
    const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true });
    if (value.exceptionDetails) {
      const exception = value.exceptionDetails.exception;
      report.evaluationFailure = { className: exception?.className, unresolvedImport: /resolve module|dynamically imported|import\(/i.test(exception?.description || ''), missingRequire: /require is not defined/.test(exception?.description || '') };
      throw Error('evaluation_failed');
    }
    return value.result?.value;
  }, close: () => { sockets.delete(ws); ws.close(); } };
}
const nodeRead = expression => main.read(`(()=>{const E=process.mainModule.require('electron');const W=E.BrowserWindow.getAllWindows()[0];return (${expression});})()`);
const read = expression => ui.read(expression);
const graph = () => {
  const names = fs.readdirSync(path.join(data, 'collab-documents')).filter(name => name.endsWith('.json'));
  assert.equal(names.length, 1); return JSON.parse(fs.readFileSync(path.join(data, 'collab-documents', names[0]), 'utf8')).doc;
};
const saved = () => read("document.querySelector('.collab-panel-status')?.textContent.includes('已保存')");
async function point(expression) {
  return read(`(()=>{const el=${expression};if(!el)throw Error();el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
}
async function mouse(type, p, modifiers = 0) {
  await ui.send('Input.dispatchMouseEvent', { type, ...p, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, modifiers });
}
async function clickExpression(expression, modifiers = 0) {
  const p = await point(expression); await mouse('mouseMoved', p, modifiers); await mouse('mousePressed', p, modifiers); await mouse('mouseReleased', p, modifiers); await sleep(90);
}
const click = selector => clickExpression(`document.querySelector(${JSON.stringify(selector)})`);
const button = text => clickExpression(`Array.from(document.querySelectorAll('.collab-panel-body button')).find(b=>!b.hidden&&b.textContent===${JSON.stringify(text)})`);
async function key(key, code, vk, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) await ui.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, modifiers });
  await sleep(90);
}
async function shot(name) {
  const result = await ui.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, name), Buffer.from(result.data, 'base64')); report.screenshots.push(name);
}
function processes() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0); return JSON.parse(result.stdout);
}
function family(all, pid) {
  const rootProcess = all.find(item => item.ProcessId === pid);
  if (!rootProcess) return [];
  const created = item => {
    const match = /Date\((\d+)/.exec(item.CreationDate);
    const time = match ? Number(match[1]) : Date.parse(item.CreationDate);
    assert.ok(Number.isFinite(time), 'process creation identity unavailable'); return time;
  };
  const owned = new Map([[pid, rootProcess]]);
  // Windows retains a dead parent's numeric PPID. Exclude an older process
  // whose recorded parent PID has since been reused by this fixture.
  for (let changed = true; changed;) { changed = false; for (const item of all) if (owned.has(item.ParentProcessId) && !owned.has(item.ProcessId) && created(item) >= created(owned.get(item.ParentProcessId))) { owned.set(item.ProcessId, item); changed = true; } }
  return all.filter(item => owned.has(item.ProcessId));
}
async function stop() {
  const identities = family(processes(), child.pid);
  observed.push(...identities);
  await nodeRead('setTimeout(()=>E.app.quit(),100),true');
  // Node's inspector can keep an otherwise finished main process alive until
  // the debugger detaches. Disconnect before observing the real exit.
  ui.close(); main.close(); ui = main = null;
  await until(() => child.exitCode !== null || child.signalCode !== null, 'packaged normal app exit');
  let residual;
  await until(() => { const now = processes(); residual = identities.filter(item => now.some(current => current.ProcessId === item.ProcessId && current.CreationDate === item.CreationDate)); return residual.length === 0; }, 'packaged process cleanup');
  check('packaged owned process identities all exited', residual.length === 0 && identities.length >= 2);
  report.launches.push({ observed: identities.length, residual: residual.length, exitCode: child.exitCode });
  child = null;
}
async function launch() {
  let traceOffset = 0;
  try { traceOffset = fs.readFileSync(path.join(world, 'network.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { /* first launch */ }
  const backendPort = await port(), cdpPort = await port(), inspectPort = await port();
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { PORT: String(backendPort), HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'),
    PI_GUI_DATA: data, PI_CWD: repo, PI_BIN: path.join(world, 'pi.cmd'), PI_CODING_AGENT_DIR: path.join(home, 'agent'), PI_GUI_OPEN: '0', PI_GUI_OFFLINE: '1', PI_OFFLINE: '1', PI_FAKE_COLLAB: '1',
    Z4_NETWORK_ROLE: 'backend', Z4_NETWORK_TRACE: path.join(world, 'network.jsonl'), NODE_OPTIONS: `--require="${guard.replaceAll('\\', '/')}"` });
  child = spawn(exe, [`--user-data-dir=${path.join(world, 'electron')}`, `--inspect-brk=127.0.0.1:${inspectPort}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`, '--disable-background-networking', `--proxy-server=http://127.0.0.1:${proxy.address().port}`, '--proxy-bypass-list=127.0.0.1;localhost;[::1]'], { cwd: world, env, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  let target, mainTarget;
  await until(async () => { try { mainTarget = (await json(`http://127.0.0.1:${inspectPort}/json/list`))[0]; return !!mainTarget; } catch { return false; } }, 'packaged main inspector');
  main = await connect(mainTarget.webSocketDebuggerUrl);
  await main.send('Runtime.enable'); await main.send('Debugger.enable'); await main.send('Runtime.runIfWaitingForDebugger');
  await until(() => main.events.includes('Debugger.paused'), 'packaged entry paused');
  // Packaged Electron ignores the NODE_OPTIONS --require flag. Before its
  // unmodified entry runs, prepend the existing test guard to exactly the
  // bundled backend command. No production file or RPC command is changed.
  const appServer = path.join(path.dirname(exe), 'resources/app/server.cjs');
  check('test guard attached before bundled backend launch', await main.read(`(()=>{const cp=process.getBuiltinModule('child_process'),original=cp.spawn;cp.spawn=function(cmd,args,options){if(cmd===process.execPath&&args?.[0]===${JSON.stringify(appServer)})args=['--require',${JSON.stringify(guard)},...args];return original.call(this,cmd,args,options)};return true})()`, false));
  report.guardInjection = 'main inspector before entry: prepend existing --require guard only to exact bundled server.cjs spawn; Chromium uses loopback-only proxy';
  await main.send('Debugger.resume');
  await until(() => {
    try { return fs.readFileSync(path.join(world, 'network.jsonl'), 'utf8').split('\n').filter(Boolean).slice(traceOffset).map(JSON.parse).some(e => e.role === 'backend' && e.event === 'installed' && e.api === 'fetch'); }
    catch { return false; }
  }, 'packaged backend guard installed before interaction');
  await until(async () => { try { target = (await json(`http://127.0.0.1:${cdpPort}/json/list`)).find(item => item.type === 'page' && item.url === `http://127.0.0.1:${backendPort}/`); return !!target; } catch { return false; } }, 'packaged renderer endpoint', 40000);
  ui = await connect(target.webSocketDebuggerUrl);
  await ui.send('Runtime.enable');
  report.inspectorBindings = await main.read("({require:typeof require,mainModule:typeof process.mainModule,mainModuleRequire:typeof process.mainModule?.require})");
  await nodeRead('W.show(),W.focus(),true'); await ui.send('Page.bringToFront');
  report.preferences = await nodeRead('W.webContents.getLastWebPreferences()').then(p => ({ sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration }));
  check('actual packaged window has sandbox/contextIsolation and no Node integration', report.preferences.sandbox === true && report.preferences.contextIsolation === true && report.preferences.nodeIntegration === false);
  check('actual packaged main uses independent artifact and TEMP userData', await nodeRead(`E.app.isPackaged&&E.app.getPath('userData')===${JSON.stringify(path.join(world, 'electron'))}`));
  await until(() => read("document.readyState==='complete'&&!!document.querySelector('#connText')").catch(() => false), 'packaged DOM ready');
  await until(() => read("import(location.origin+'/state.js').then(({S})=>S.bridgeState==='ready'&&!!S.legacyOwner?.sessionId)").catch(() => false), 'packaged native owner ready');
  observed.push(...family(processes(), child.pid));
  await read("window.z46Input={mouse:0,key:0};document.addEventListener('pointerdown',e=>{if(e.isTrusted)window.z46Input.mouse++},true);document.addEventListener('keydown',e=>{if(e.isTrusted)window.z46Input.key++},true)");
  await ui.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(world, 'downloads') });
  report.versions = await nodeRead('({electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node,app:E.app.getVersion()})');
}

try {
  fs.mkdirSync(output, { recursive: true });
  if (osInput) for (const file of ['os-input-ready.json', 'os-input-done.json']) fs.rmSync(path.join(output, file), { force: true });
  proxy = http.createServer((_request, response) => { report.chromiumProxyDenied = (report.chromiumProxyDenied || 0) + 1; response.writeHead(502); response.end(); });
  proxy.on('connect', (_request, socket) => { report.chromiumProxyDenied = (report.chromiumProxyDenied || 0) + 1; socket.destroy(); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  for (const dir of [repo, data, home, path.join(world, 'downloads')]) fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(world, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-b', 'main'); git('config', 'user.name', 'Offline fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'example.js'), 'export const fixture = true;\n'); git('add', '.'); git('commit', '-m', 'fixture');
  const sourceHash = hash(fs.readFileSync(path.join(repo, 'example.js')));
  fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify({ active: repo, items: [{ path: repo, name: 'Z4-6B packaged TEMP fixture' }] }));
  const pkg = path.join(world, 'node_modules/@earendil-works/pi-coding-agent');
  for (const dir of ['dist/core/extensions', 'dist/cli']) fs.mkdirSync(path.join(pkg, dir), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.3.0', bin: { pi: 'cli.cjs' } }));
  fs.writeFileSync(path.join(pkg, 'dist/core/extensions/types.d.ts'), '"tool_call" "tool_execution_end" getAllTools() registerTool<');
  fs.writeFileSync(path.join(pkg, 'dist/cli/args.js'), 'if (arg === "--extension") {}');
  fs.copyFileSync(path.join(root, 'tests/fixtures/candidate-pi.cjs'), path.join(pkg, 'cli.cjs'));
  fs.writeFileSync(path.join(world, 'pi.cmd'), `@echo off\r\nset "Z4_NETWORK_ROLE=pi"\r\n"${process.execPath}" --require "${guard}" "${path.join(pkg, 'cli.cjs')}" %*\r\n`);
  report.executableSha256 = hash(fs.readFileSync(exe));
  await launch();
  check('packaged backend rejects collab without Owner', await read("fetch('/api/collab-documents',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'open'})}).then(async r=>r.status===409&&(await r.json()).code==='collab_scope_unavailable')"));
  check('no Owner request created no document', !fs.existsSync(path.join(data, 'collab-documents')));
  await click('#btnCollab'); await until(() => read("!!document.querySelector('.collab-panel-actions button:not([hidden])')"), 'packaged create control');
  await button('新建流程图'); await until(saved, 'packaged create saved');
  check('packaged panel creates durable three-node document', graph().graph.nodes.length === 3);
  if (osInput) {
    const before = graph(), counts = await read('window.z46Input');
    await nodeRead("W.setTitle('Z4-6B TEMP OS input smoke'),true");
    fs.writeFileSync(path.join(output, 'os-input-ready.json'), JSON.stringify({ ready: true, requested: 'Windows mouse select n2, then Right key; TEMP document only' }) + '\n');
    await until(() => fs.existsSync(path.join(output, 'os-input-done.json')), 'Windows input smoke handshake', 180000);
    await until(() => graph().revision > before.revision, 'Windows input durable operation'); await until(saved, 'Windows input save ack');
    const after = graph(), delivered = await read('window.z46Input');
    check('Windows system mouse and Right key move the temporary node through CAS', after.graph.nodes.find(n => n.id === 'n2').x === before.graph.nodes.find(n => n.id === 'n2').x + 10 && delivered.mouse > counts.mouse && delivered.key > counts.key);
    report.osInput = { source: 'Computer Use @oai/sky Windows SendInput', mouseDelta: delivered.mouse - counts.mouse, keyDelta: delivered.key - counts.key, nodeDeltaX: 10, revisionDelta: after.revision - before.revision };
    await shot('packaged-os-input.png');
  }
  await click('[data-node-id="n2"]'); await click('.collab-edit-form input');
  await key('a', 'KeyA', 65, 2); await ui.send('Input.insertText', { text: '打包窗口编辑' }); await button('保存文字');
  await until(() => graph().graph.nodes.find(n => n.id === 'n2').label === '打包窗口编辑', 'packaged label durable'); await until(saved, 'label ack');
  check('packaged native text input saves through authoritative store', true);
  const box = await read("(()=>{document.querySelector('.collab-stage').scrollIntoView({block:'center'});const rs=Array.from(document.querySelectorAll('.collab-node rect'),e=>e.getBoundingClientRect());return {a:{x:Math.min(...rs.map(r=>r.left))-8,y:Math.min(...rs.map(r=>r.top))-8},b:{x:Math.max(...rs.map(r=>r.right))+8,y:Math.max(...rs.map(r=>r.bottom))+8}}})()");
  await mouse('mousePressed', box.a, 8); await ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box.b, button: 'left', buttons: 1, modifiers: 8 }); await mouse('mouseReleased', box.b, 8);
  check('trusted Shift drag marquee selects the three visible nodes', await read("document.querySelectorAll('.collab-node.is-selected').length===3"));
  await click('[data-node-id="n1"]'); await clickExpression("document.querySelector('[data-node-id=\"n2\"]')", 2);
  check('trusted Ctrl click selects two nodes', await read("document.querySelectorAll('.collab-node.is-selected').length===2"));
  const before = graph(), p = await point("document.querySelector('[data-node-id=\"n1\"] rect')");
  await mouse('mousePressed', p); await ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + 28, y: p.y + 18, button: 'left', buttons: 1 }); await mouse('mouseReleased', { x: p.x + 28, y: p.y + 18 });
  await until(() => graph().revision > before.revision, 'packaged batch drag'); await until(saved, 'drag ack');
  const moved = graph();
  check('multi-node drag preserves relative displacement', ['n1', 'n2'].every(id => moved.graph.nodes.find(n => n.id === id).x !== before.graph.nodes.find(n => n.id === id).x) &&
    moved.graph.nodes[1].x - moved.graph.nodes[0].x === before.graph.nodes[1].x - before.graph.nodes[0].x && moved.graph.nodes[1].y - moved.graph.nodes[0].y === before.graph.nodes[1].y - before.graph.nodes[0].y);
  await read("document.querySelector('.collab-align-form select').value='left'"); await button('应用对齐');
  await until(() => graph().revision > moved.revision, 'packaged alignment'); await until(saved, 'alignment ack');
  check('two-node alignment uses a single persisted batch', graph().revision === moved.revision + 1 && graph().graph.nodes[0].x === graph().graph.nodes[1].x);
  const corner = await read("(()=>{const e=document.querySelector('.collab-stage');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.left+8,y:r.top+8}})()");
  await mouse('mouseMoved', corner, 2); await mouse('mousePressed', corner, 2); await mouse('mouseReleased', corner, 2);
  await key('c', 'KeyC', 67, 2); await key('v', 'KeyV', 86, 2); await until(() => graph().graph.nodes.length === 5, 'packaged shortcut paste'); await until(saved, 'paste ack');
  check('native Ctrl C/V copies internal selection atomically', graph().graph.nodes.length === 5);
  const pastedGraph = graph().graph;
  await key('Delete', 'Delete', 46); await until(() => read("!document.querySelector('#confirmLayer').hidden"), 'packaged delete confirmation');
  await clickExpression("Array.from(document.querySelectorAll('#confirmCard button')).find(b=>b.textContent==='删除')");
  await until(() => graph().graph.nodes.length === 3, 'packaged delete persisted'); await until(saved, 'delete ack');
  await button('撤销'); await until(() => graph().graph.nodes.length === 5, 'packaged undo batch delete'); await until(saved, 'undo ack');
  check('batch delete and undo restore exact nodes and edges together', JSON.stringify(graph().graph) === JSON.stringify(pastedGraph));
  const previewRevision = graph().revision;
  await button('自动整理'); await until(() => read("!!document.querySelector('.collab-prod-preview:not([hidden])')"), 'layout preview');
  await shot('packaged-layout-preview.png');
  check('layout preview does not commit document', graph().revision === previewRevision);
  await button('确认应用布局'); await until(() => graph().revision > previewRevision, 'packaged layout saved'); await until(saved, 'layout ack');
  check('layout commits one authoritative batch', graph().revision === previewRevision + 1);
  for (const format of ['SVG', 'PNG']) {
    await button('导出 ' + format);
    await until(() => fs.readdirSync(path.join(world, 'downloads')).some(name => name.endsWith('.' + format.toLowerCase())), 'packaged ' + format + ' download');
    const name = fs.readdirSync(path.join(world, 'downloads')).find(name => name.endsWith('.' + format.toLowerCase()));
    const bytes = fs.readFileSync(path.join(world, 'downloads', name));
    check('packaged ' + format + ' actual download bytes', format === 'PNG' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes.toString('utf8').includes('<svg'));
    fs.writeFileSync(path.join(output, 'packaged-export.' + format.toLowerCase()), bytes);
  }
  const inputs = await read('window.z46Input'); check('mouse and keyboard reached trusted DOM handlers', inputs.mouse >= 10 && inputs.key >= 4); report.trustedInput = inputs;
  await shot('packaged-editor.png');
  const durable = graph(); await click('#rightPaneClose'); await click('#btnCollab'); await until(saved, 'packaged reopen');
  check('panel reopen restores document and empties undo history', graph().revision === durable.revision && await read("Array.from(document.querySelectorAll('.collab-toolbar button')).find(b=>b.textContent==='撤销').disabled"));
  await stop(); await launch(); await click('#btnCollab'); await until(saved, 'packaged restart document reopen');
  check('real app restart recovers exact document', JSON.stringify(graph()) === JSON.stringify(durable));
  await shot('packaged-restarted.png'); await stop();
  check('synthetic project source bytes unchanged', hash(fs.readFileSync(path.join(repo, 'example.js'))) === sourceHash);
  const trace = fs.readFileSync(path.join(world, 'network.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  report.networkGuard = { installed: trace.filter(e => e.event === 'installed').length, blocked: trace.filter(e => e.event === 'blocked').length };
  check('offline preload was installed in packaged backend', trace.some(e => e.role === 'backend' && e.event === 'installed' && e.api === 'fetch'));
} catch (error) {
  report.failedDebugCommand = report.lastDebugCommand;
  report.failed = 1; report.failureStage = stage; report.failureCode = error.code || error.message;
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    observed.push(...family(processes(), child.pid));
    try { if (main) await nodeRead('setTimeout(()=>E.app.quit(),100),true'); } catch { /* bounded command failure retained above */ }
    for (const ws of sockets) ws.close();
    await sleep(500);
  }
  for (const ws of sockets) ws.close();
  // Also account for a child that exited before normal shutdown observation;
  // never target a reused PID or an unrelated desktop process.
  const all = processes();
  for (const identity of observed.filter(item => all.some(now => now.ProcessId === item.ProcessId && now.CreationDate === item.CreationDate)).reverse()) {
    if (processes().some(now => now.ProcessId === identity.ProcessId && now.CreationDate === identity.CreationDate)) spawnSync('taskkill', ['/pid', String(identity.ProcessId), '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
  }
  const after = processes();
  report.finalResidual = observed.filter(item => after.some(now => now.ProcessId === item.ProcessId && now.CreationDate === item.CreationDate)).length;
  if (report.finalResidual) { report.failed = 1; report.failureStage ||= 'final process cleanup'; process.exitCode = 1; }
  proxy?.closeAllConnections(); if (proxy) await new Promise(resolve => proxy.close(resolve));
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  const relative = path.relative(os.tmpdir(), fs.realpathSync(world)); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  if (!report.finalResidual) fs.rmSync(world, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  console.log(JSON.stringify({ checks: report.checks.length, failed: report.failed, stage: report.failureStage }));
}
