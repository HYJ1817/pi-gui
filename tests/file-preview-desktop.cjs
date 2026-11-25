'use strict';
// Explicit normal-sandbox desktop qualification, separate from headless canonical.
// node tests/file-preview-desktop.cjs; PREVIEW_APP_ROOT may select built resources/app.
// The fixture main is NOT electron/main.cjs and never claims packaged-main proof.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-preview-desktop-'));
const out = path.resolve(process.env.PREVIEW_DESKTOP_OUTPUT || path.join(world, 'evidence'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, spawnError, observed = [];
function identities() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, 'process identity observation unavailable');
  return [].concat(JSON.parse(result.stdout));
}
function descendants(all, parent) {
  const owned = new Set([parent]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of all) if (owned.has(row.ParentProcessId) && !owned.has(row.ProcessId)) { owned.add(row.ProcessId); changed = true; }
  }
  return all.filter(row => owned.has(row.ProcessId));
}
function updateReport(patch) {
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'results.json');
  const report = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { qualification: 'unverified', passed: 0, failed: 0, rows: [] };
  Object.assign(report, patch);
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  return report;
}
async function main() {
  if (process.platform !== 'win32') throw new Error('environment-blocked: Windows desktop qualification only');
  const appRoot = path.resolve(process.env.PREVIEW_APP_ROOT || ROOT);
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'ELECTRON_OVERRIDE_DIST_PATH']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { PREVIEW_DESKTOP_WORLD: world, PREVIEW_DESKTOP_OUTPUT: out, PREVIEW_APP_ROOT: appRoot, PREVIEW_NODE_EXECUTABLE: process.execPath,
    PREVIEW_SELECTION_ONLY: process.argv.includes('--selection-only') ? '1' : '0',
    HOME: path.join(world, 'home'), USERPROFILE: path.join(world, 'home'), APPDATA: path.join(world, 'home/AppData/Roaming'), LOCALAPPDATA: path.join(world, 'home/AppData/Local') });
  fs.mkdirSync(out, { recursive: true });
  // Some shared node_modules retain a non-Windows path.txt. An explicit
  // private offline runtime selects its native executable without editing it.
  const electron = env.ELECTRON_OVERRIDE_DIST_PATH ? path.join(env.ELECTRON_OVERRIDE_DIST_PATH, 'electron.exe') : require('electron');
  assert.ok(fs.existsSync(electron), 'explicit offline Electron executable exists');
  const runtime = { executable: electron, sha256: crypto.createHash('sha256').update(fs.readFileSync(electron)).digest('hex'), override: !!env.ELECTRON_OVERRIDE_DIST_PATH };
  child = spawn(electron, [path.join(__dirname, 'fixtures/file-preview-desktop-main.cjs'), '--user-data-dir=' + path.join(world, 'electron')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.once('error', error => { spawnError = error.code || 'spawn_error'; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stdout.on('data', data => process.stdout.write(data));
  // Chromium may log URLs/paths; retain only structural counts in the report.
  let stderrChunks = 0; child.stderr.on('data', () => { stderrChunks++; });
  // The complete four-viewport/theme selection matrix precedes the format and
  // layout scenarios. Allow that whole sequence to finish on a busy Windows
  // host; individual readiness waits still retain their 10/22-second bounds.
  const deadline = Date.now() + 480000;
  while (!fs.existsSync(path.join(world, 'ready-for-cleanup')) && child.exitCode === null && !spawnError && Date.now() < deadline) await sleep(100);
  if (spawnError) throw new Error('environment-blocked: Electron ' + spawnError);
  if (child.exitCode === null && fs.existsSync(path.join(world, 'ready-for-cleanup'))) {
    observed = descendants(identities(), child.pid);
    assert.ok(observed.length >= 2, 'observe actual desktop/backend process family');
    fs.writeFileSync(path.join(world, 'processes-observed'), 'yes');
  } else if (child.exitCode === null) throw new Error('desktop qualification timeout');
  let timer, exit;
  try { exit = await Promise.race([exited, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('cleanup timeout')), 25000); })]); }
  finally { clearTimeout(timer); }
  let residual = [];
  for (let index = 0; index < 5; index++) {
    const all = identities();
    residual = observed.filter(row => all.some(current => current.ProcessId === row.ProcessId && current.CreationDate === row.CreationDate));
    if (!residual.length) break;
    await sleep(200);
  }
  const cleanupPassed = observed.length >= 2 && residual.length === 0;
  const report = updateReport({ runtime, processCleanup: { observed: observed.length, residual: residual.length, passed: cleanupPassed }, stderrChunks, exit });
  assert.equal(exit.code, 0, 'Electron qualification must finish explicitly');
  assert.equal(report.qualification, 'normal-sandbox');
  assert.equal(report.failed, 0, 'desktop checks must pass');
  assert.ok(cleanupPassed, 'all observed process identities must exit');
  console.log(`File preview desktop: ${report.passed + 1}/${report.passed + 1}; normal sandbox; residual ${residual.length}; ${out}`);
}
main().catch(error => {
  process.exitCode = 1;
  const report = updateReport({ runnerFailure: error.name === 'AssertionError' ? error.message : 'environment-or-runner-failure', evidence: out });
  console.error(`File preview desktop: ${report.passed || 0} passed / ${report.failed || 0} failed; runner ${error.name}; ${out}`);
}).finally(() => {
  if (Number.isInteger(child?.pid) && child.exitCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  // Preserve fixture data alongside evidence for reproducibility; external output
  // permits removing disposable input/userData after all owned processes exit.
  if (!out.startsWith(world + path.sep)) fs.rmSync(world, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
