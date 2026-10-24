// Small Windows desktop entry; reuses existing preload, Browser and fake Pi.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-g2-smoke-'));
const out = path.resolve(process.env.G2_SMOKE_OUTPUT || path.join(world, 'evidence'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, spawnError, snapshot = [];

function processes() {
  // Only process identities are retained, never ambient command lines.
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, 'process identity observation unavailable');
  return JSON.parse(result.stdout);
}
function descendants(all, parent) {
  const owned = new Set([parent]);
  for (let changed = true; changed;) {
    changed = false;
    for (const item of all) if (owned.has(item.ParentProcessId) && !owned.has(item.ProcessId)) { owned.add(item.ProcessId); changed = true; }
  }
  return all.filter(item => owned.has(item.ProcessId));
}
async function main() {
  if (process.platform !== 'win32') throw new Error('environment-blocked: this smoke currently qualifies Windows desktop only');
  fs.mkdirSync(out, { recursive: true });
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'ELECTRON_OVERRIDE_DIST_PATH']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { G2_SMOKE_WORLD: world, G2_SMOKE_OUTPUT: out, G2_NODE_EXECUTABLE: process.execPath,
    HOME: path.join(world, 'home'), USERPROFILE: path.join(world, 'home'), APPDATA: path.join(world, 'home/AppData/Roaming'), LOCALAPPDATA: path.join(world, 'home/AppData/Local'),
  });
  child = spawn(require('electron'), [path.join(__dirname, 'fixtures/g2-electron-smoke.cjs'), '--user-data-dir=' + path.join(world, 'electron')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.once('error', error => { spawnError = error.code || 'spawn_error'; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stdout.on('data', data => process.stdout.write(data));
  child.stderr.on('data', data => process.stderr.write(data));
  const deadline = Date.now() + 120000;
  while (!fs.existsSync(path.join(world, 'ready-for-cleanup')) && child.exitCode === null && !spawnError && Date.now() < deadline) await sleep(100);
  if (spawnError) throw new Error('environment-blocked: Electron ' + spawnError);
  if (child.exitCode === null && fs.existsSync(path.join(world, 'ready-for-cleanup'))) {
    snapshot = descendants(processes(), child.pid);
    assert.ok(snapshot.length >= 2, 'observe actual desktop/backend process family');
    fs.writeFileSync(path.join(world, 'processes-observed'), 'yes');
  } else if (child.exitCode === null) throw new Error('smoke timeout');
  let cleanupTimer;
  let exit;
  try { exit = await Promise.race([exited, new Promise((_resolve, reject) => { cleanupTimer = setTimeout(() => reject(new Error('cleanup timeout')), 20000); })]); }
  finally { clearTimeout(cleanupTimer); }
  let residual = [];
  for (let index = 0; index < 5; index++) {
    const all = processes();
    residual = snapshot.filter(item => all.some(current => current.ProcessId === item.ProcessId && current.CreationDate === item.CreationDate));
    if (!residual.length) break;
    await sleep(250);
  }
  const file = path.join(out, 'results.json');
  const report = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { qualification: 'unverified', checks: 0, failed: 1 };
  Object.assign(report, { processCleanup: { observed: snapshot.length, residual: residual.length }, exit });
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  assert.equal(exit.code, 0, 'Electron fixture must finish explicitly');
  assert.equal(report.qualification, 'normal-sandbox');
  assert.equal(report.failed, 0);
  assert.equal(residual.length, 0, 'fixture process identities must all exit');
  assert.ok(snapshot.length >= 2);
  console.log(`Electron smoke: ${report.checks + 1}/${report.checks + 1}; normal sandbox; residual processes 0; ${out}`);
}
main().catch(error => {
  console.error(error); process.exitCode = 1;
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'results.json');
  const report = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { qualification: 'environment-blocked', checks: 0 };
  report.failed = 1; report.failureReason = error.message;
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
}).finally(() => {
  if (Number.isInteger(child?.pid) && child.exitCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  // Evidence remains in the explicit output directory; fixture data is local
  // and disposable. Preserve the temp root when it also owns the evidence.
  if (!out.startsWith(world + path.sep)) fs.rmSync(world, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
