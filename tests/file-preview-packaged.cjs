'use strict';
/* Opt-in Windows qualification after build:app -- --rebuild. Tests every public
 * asset in App/staging/SEA, then the actual packaged production main via a TEMP
 * manifest observation bootstrap. No real project, Pi, model, network or install. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const zlib = require('node:zlib');
const { createHash, randomBytes } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const SOURCE = path.resolve(__dirname, '..');
const outputAt = process.argv.indexOf('--output-root');
const OUTPUT = outputAt < 0 ? SOURCE : process.argv[outputAt + 1];
assert.ok(OUTPUT && path.isAbsolute(OUTPUT), '--output-root must be absolute');
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-preview-packaged-'));
const out = path.join(world, 'evidence'); fs.mkdirSync(out);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = file => hash(fs.readFileSync(file));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rows = [], artifacts = {};
let child;
function check(name, value, details) {
  assert.ok(value, name); rows.push({ name, passed: true, ...(details ? { details } : {}) }); console.log('PASS ' + name);
}
async function until(test, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await test()) return; await sleep(50); }
  throw Object.assign(Error('qualification timeout'), { testLabel: label });
}
async function freePort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function files(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    assert.ok(!entry.isSymbolicLink(), 'ordinary build asset only');
    return entry.isDirectory() ? files(root, relative) : [relative];
  }).sort();
}
function identities() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, 'owned process identity observation'); return [].concat(JSON.parse(result.stdout));
}
function descendants(all, parent) {
  const owned = new Set([parent]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of all) if (owned.has(row.ParentProcessId) && !owned.has(row.ProcessId)) { owned.add(row.ProcessId); changed = true; }
  }
  return all.filter(row => owned.has(row.ProcessId));
}
const env = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
for (const name of ['home', 'roaming', 'local', 'tmp', 'profile', 'sea-data']) fs.mkdirSync(path.join(world, name));
Object.assign(env, { HOME: path.join(world, 'home'), USERPROFILE: path.join(world, 'home'), APPDATA: path.join(world, 'roaming'), LOCALAPPDATA: path.join(world, 'local'),
  TEMP: path.join(world, 'tmp'), TMP: path.join(world, 'tmp'), PI_GUI_OPEN: '0', PI_GUI_OFFLINE: '1', PI_OFFLINE: '1', PI_CODING_AGENT_DIR: path.join(world, 'home/agent') });
async function checkAssets(appRoot) {
  const publicRoot = path.join(SOURCE, 'public'), list = files(publicRoot);
  const assets = list.map(file => ({ file, bytes: fs.statSync(path.join(publicRoot, file)).size, sha256: digest(path.join(publicRoot, file)) }));
  for (const root of [path.join(OUTPUT, 'build/electron-app/public'), path.join(appRoot, 'public')]) {
    assert.deepEqual(files(root), list, 'exact complete public resource set');
    for (const item of assets) assert.equal(digest(path.join(root, item.file)), item.sha256, 'public byte identity ' + item.file);
  }
  check('all staging and packaged public files equal source', true, { files: assets.length, bytes: assets.reduce((sum, item) => sum + item.bytes, 0) });
  artifacts.publicTreeSha256 = hash(JSON.stringify(assets)); artifacts.publicFiles = assets.length;
  const token = randomBytes(32).toString('hex'), port = await freePort(), origin = 'http://127.0.0.1:' + port;
  const exe = path.join(OUTPUT, 'build/Pi GUI.exe');
  artifacts.sea = { bytes: fs.statSync(exe).size, sha256: digest(exe) };
  const server = spawn(exe, [], { cwd: world, env: { ...env, PORT: String(port), PI_GUI_DATA: path.join(world, 'sea-data'), PI_GUI_TOKEN: token, PI_CWD: '', PI_BIN: path.join(world, 'no-pi.cmd') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let exit;
  const exited = new Promise((resolve, reject) => { server.once('error', reject); server.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit); }); });
  server.stdout.resume(); server.stderr.resume();
  try {
    await until(async () => { assert.equal(exit, undefined, 'SEA remains alive'); try { return (await fetch(origin + '/api/health')).ok; } catch { return false; } }, 'sea-health');
    const headers = { 'x-pi-gui-token': token };
    assert.equal((await fetch(origin + '/api/status')).status, 401);
    const status = await (await fetch(origin + '/api/status', { headers })).json();
    check('SEA authentication and no-project isolation', status.hasProject === false && status.piRunning === false);
    for (const item of assets) {
      const response = await fetch(origin + '/' + item.file.split('/').map(encodeURIComponent).join('/'), { headers });
      assert.equal(response.status, 200, 'SEA resource status ' + item.file);
      assert.equal(hash(Buffer.from(await response.arrayBuffer())), item.sha256, 'SEA embedded bytes ' + item.file);
      if (/\.m?js$/.test(item.file)) assert.match(response.headers.get('content-type') || '', /javascript/, 'ESM worker MIME ' + item.file);
      if (/\.wasm$/.test(item.file)) assert.match(response.headers.get('content-type') || '', /application\/wasm/, 'WASM MIME ' + item.file);
    }
    check('all SEA served public bytes match source including worker font CMap WASM', true, { files: assets.length });
  } finally {
    if (!exit) server.kill(); await exited;
    check('SEA resource probe exits without Pi descendants', !!exit);
  }
}
async function main() {
  assert.equal(process.platform, 'win32', 'Windows desktop required');
  const app = path.join(OUTPUT, 'dist-app/Pi GUI-win32-x64');
  const originalRoot = path.join(app, 'resources/app');
  await checkAssets(originalRoot);
  const { copyInto } = await import('../scripts/util.mjs');
  copyInto(world, app, 'application');
  const appRoot = path.join(world, 'application/resources/app'), executable = path.join(world, 'application/Pi GUI.exe');
  const modules = {};
  for (const file of fs.readdirSync(path.join(SOURCE, 'electron')).filter(file => file.endsWith('.cjs'))) {
    assert.equal(digest(path.join(appRoot, file)), digest(path.join(SOURCE, 'electron', file)), 'actual desktop module ' + file);
    modules[file] = digest(path.join(appRoot, file));
  }
  check('packaged production desktop modules are byte-identical', true, { files: Object.keys(modules).length });
  artifacts.app = { bytes: fs.statSync(executable).size, sha256: digest(executable), backendSha256: digest(path.join(appRoot, 'server.cjs')), modules };
  /* Diagnostic open-chain spy: patch ONLY the runtime copy's files-panel.js
   * (never source, never the byte-verified staging). The final assertion below
   * re-verifies source public bytes are unchanged, so this instrumentation is
   * confined to the disposable world/application copy. It records the exact
   * guard that stops a file open, per the R0 diagnosis that the open path's
   * runtime trace must be captured rather than guessed. Opt-in via env so the
   * canonical packaged run stays byte-clean. */
  if (process.env.PREVIEW_OPENCHAIN_SPY === '1') {
    const target = path.join(appRoot, 'public/files-panel.js');
    fs.copyFileSync(path.join(SOURCE, 'public/files-panel.js'), target);
    const spy = spawnSync('python', [path.join(SOURCE, 'tests/fixtures/inject-openchain-spy.py'), target], { encoding: 'utf8' });
    assert.equal(spy.status, 0, 'open-chain spy injection: ' + (spy.stderr || spy.stdout));
    artifacts.openChainSpy = true;
  }
  process.env.PREVIEW_NODE_EXECUTABLE = process.execPath;
  const fixture = await require('./fixtures/file-preview-desktop-data.cjs')({ SOURCE, world, repo: path.join(world, 'repo') });
  // Avoid production catalog prefetch even before the network guards reject it.
  fs.writeFileSync(path.join(fixture.data, 'mcp-registry-catalog.json.gz'), zlib.gzipSync(JSON.stringify({ version: 1, at: Date.now(), pages: 0, network: null, items: [] })));
  const offline = path.join(world, 'offline.cjs');
  fs.writeFileSync(offline, `require(${JSON.stringify(path.join(SOURCE, 'tests/fixtures/system-settings-offline.cjs'))});const original=global.fetch;global.fetch=(input,options)=>{const u=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))return Promise.reject(Error('offline_fixture'));return original(input,options)};if(/[\\\\/]server\\.(?:cjs|js)$/.test(process.argv[1]||''))require('node:fs').writeFileSync(require('node:path').join(process.env.PREVIEW_DESKTOP_WORLD,'offline-backend'),'guarded');\n`);
  const manifest = path.join(appRoot, 'package.json'), config = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  artifacts.originalManifestSha256 = digest(manifest); config.main = 'file-preview-observer.cjs';
  fs.writeFileSync(path.join(appRoot, config.main), `require(${JSON.stringify(path.join(SOURCE, 'tests/fixtures/file-preview-packaged-main.cjs'))});\n`, { flag: 'wx' });
  fs.writeFileSync(manifest, JSON.stringify(config)); artifacts.bootstrapManifestOverride = true;
  const port = await freePort();
  child = spawn(executable, ['--user-data-dir=' + path.join(world, 'profile'), '--disable-background-networking'], { cwd: world, env: { ...env, PORT: String(port), PI_GUI_DATA: fixture.data,
    PI_CWD: path.join(world, 'repo'), PI_BIN: fixture.shim, PREVIEW_NODE_EXECUTABLE: process.execPath, PREVIEW_APP_ROOT: appRoot,
    PREVIEW_DESKTOP_WORLD: world, PREVIEW_DESKTOP_OUTPUT: out, PREVIEW_OFFLINE_PRELOAD: offline }, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let exit;
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit); }); });
  child.stdout.on('data', chunk => process.stdout.write(chunk)); child.stderr.resume();
  await until(() => { assert.equal(exit, undefined, 'packaged production main remains alive'); return fs.existsSync(path.join(world, 'ready-for-cleanup')); }, 'packaged-interaction', 270000);
  const observed = descendants(identities(), child.pid);
  check('observe actual packaged desktop backend Pi process family', observed.length >= 3, { observed: observed.length });
  fs.writeFileSync(path.join(world, 'processes-observed'), 'observed');
  let timer;
  await Promise.race([exited, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('production quit timeout')), 30000); })]).finally(() => clearTimeout(timer));
  let residual = [];
  await until(() => { const current = identities(); residual = observed.filter(row => current.some(other => row.ProcessId === other.ProcessId && row.CreationDate === other.CreationDate)); return residual.length === 0; }, 'production-process-cleanup', 15000);
  check('production quit removes all observed process identities', residual.length === 0, { observed: observed.length, residual: residual.length });
  assert.equal(exit.code, 0, 'production desktop explicit exit');
  const report = JSON.parse(fs.readFileSync(path.join(out, 'desktop.json'), 'utf8'));
  assert.equal(report.failed, 0, 'packaged UI assertions');
  check('actual packaged main completes all viewer interactions', report.passed > 50, { passed: report.passed, failed: report.failed, skipped: report.skipped });
  for (const [file, sha256] of Object.entries(modules)) assert.equal(digest(path.join(appRoot, file)), sha256, 'desktop modules unchanged after interaction');
  // With the open-chain spy active the runtime files-panel.js is intentionally
  // instrumented; skip only that one file's post-interaction byte comparison.
  const spyActive = process.env.PREVIEW_OPENCHAIN_SPY === '1';
  for (const file of files(path.join(SOURCE, 'public'))) {
    if (spyActive && file === 'files-panel.js') continue;
    assert.equal(digest(path.join(appRoot, 'public', file)), digest(path.join(SOURCE, 'public', file)), 'public bytes unchanged after interaction');
  }
  check('production modules and public files remain unchanged', true);
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ passed: rows.length + report.passed, failed: 0, skipped: 0, rows, artifacts,
    qualification: report.qualification, processCleanup: { observed: observed.length, residual: residual.length }, desktopReport: 'desktop.json' }, null, 2) + '\n');
  console.log(`File preview packaged: ${rows.length + report.passed}/${rows.length + report.passed}; public=${artifacts.publicFiles}; residual=${residual.length}; evidence=${out}`);
}
main().catch(error => {
  process.exitCode = 1;
  fs.writeFileSync(path.join(out, 'runner-failure.json'), JSON.stringify({ type: error.name, stage: error.testLabel || 'assertion', message: error.message, rows, artifacts }, null, 2) + '\n');
  console.error('File preview packaged failed: ' + error.message + '; evidence=' + out);
}).finally(() => {
  if (child?.exitCode === null && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
});
