/* Real production main/preload/backend/renderer; normal Windows sandbox. All
 * profiles, Pi fixtures and destructive data live in one fresh os.tmpdir root. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const p2 = process.argv.includes('--p2-only');
const world = fs.mkdtempSync(path.join(os.tmpdir(), packaged ? 'pi-system-packaged-' : 'pi-system-desktop-'));
const out = path.join(world, 'evidence'); fs.mkdirSync(out);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = path.join(world, 'profile');
const data = p2 ? profile : path.join(world, 'data-中文-long-system-settings-location-'.repeat(3));
const repo = path.join(world, 'project');
let child;
function processes() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, 'process identities must be observable');
  return JSON.parse(result.stdout);
}
function descendants(all, parent) {
  const ids = new Set([parent]);
  for (let changed = true; changed;) {
    changed = false;
    for (const item of all) if (ids.has(item.ParentProcessId) && !ids.has(item.ProcessId)) { ids.add(item.ProcessId); changed = true; }
  }
  return all.filter(item => ids.has(item.ProcessId));
}
async function run() {
  assert.equal(process.platform, 'win32', 'this qualification requires a Windows desktop');
  for (const dir of [profile, data, repo, path.join(world, 'home'), path.join(world, 'roaming'), path.join(world, 'local'), path.join(world, 'tmp')]) fs.mkdirSync(dir, { recursive: true });
  // A Git hook/wrapper may export GIT_DIR or GIT_INDEX_FILE. Neither cwd nor
  // a temporary global config confines Git while those variables are inherited.
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(gitEnv, { GIT_CONFIG_GLOBAL: path.join(world, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    HOME: path.join(world, 'home'), USERPROFILE: path.join(world, 'home') });
  const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv }).trim();
  git('init', '-b', 'main');
  assert.equal(fs.realpathSync(git('rev-parse', '--absolute-git-dir')), fs.realpathSync(path.join(repo, '.git')));
  assert.equal(fs.realpathSync(git('rev-parse', '--show-toplevel')), fs.realpathSync(repo));
  git('config', 'user.name', 'Offline fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'fixture.txt'), 'Protected project fixture\n'); git('add', '.'); git('commit', '-m', 'fixture');
  fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify({ active: repo, items: [{ name: 'Offline system acceptance', path: repo }] }));
  // Production desktop prefetch consumes a fresh local registry snapshot, not the network.
  fs.writeFileSync(path.join(data, 'mcp-registry-catalog.json.gz'), zlib.gzipSync(JSON.stringify({ version: 1, at: Date.now(), pages: 0, network: null, items: [] })));
  const pkg = path.join(world, 'node_modules/@earendil-works/pi-coding-agent');
  fs.mkdirSync(path.join(pkg, 'dist/core/extensions'), { recursive: true }); fs.mkdirSync(path.join(pkg, 'dist/cli'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.3.0', bin: { pi: 'cli.cjs' } }));
  fs.writeFileSync(path.join(pkg, 'dist/core/extensions/types.d.ts'), '"tool_call" "tool_execution_end" getAllTools() registerTool<');
  fs.writeFileSync(path.join(pkg, 'dist/cli/args.js'), 'if (arg === "--extension") {}');
  fs.copyFileSync(path.join(ROOT, 'tests/fixtures/system-settings-pi.cjs'), path.join(pkg, 'cli.cjs'));
  fs.writeFileSync(path.join(world, 'pi.cmd'), '@echo off\r\n"%SYSTEM_FIXTURE_NODE%" "%~dp0node_modules\\@earendil-works\\pi-coding-agent\\cli.cjs" %*\r\n');
  // Node backend auto-update probes fail offline. The Electron fixture separately
  // rejects non-loopback Chromium requests; no remote endpoint is contacted.
  const offline = path.join(world, 'offline.cjs');
  fs.writeFileSync(offline, `require(${JSON.stringify(path.join(ROOT, 'tests/fixtures/system-settings-offline.cjs'))});globalThis.__systemOfflineGuard=true;const base=global.fetch;global.fetch=(input,options)=>{const u=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))return Promise.reject(Error('offline_fixture'));return base(input,options)};if(/[\\\\/]server\\.(?:cjs|js)$/.test(process.argv[1]||''))require('node:fs').writeFileSync(require('node:path').join(process.env.SYSTEM_WORLD,process.env.SYSTEM_PHASE+'-offline-backend'),globalThis.__systemRawNetworkGuard?'active-raw':'missing-raw');`);
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'ELECTRON_OVERRIDE_DIST_PATH']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { SYSTEM_WORLD: world, SYSTEM_OUTPUT: out, SYSTEM_PROFILE: profile, SYSTEM_DATA: data, SYSTEM_FIXTURE_NODE: process.execPath,
    SYSTEM_PI_TRACE: path.join(world, 'pi-trace.jsonl'), SYSTEM_OFFLINE_PRELOAD: offline, PI_GUI_DATA: data, PI_CODING_AGENT_DIR: path.join(world, 'home/agent'),
    PI_CWD: repo, PI_BIN: path.join(world, 'pi.cmd'), PI_GUI_OFFLINE: '1', PI_OFFLINE: '1', PI_GUI_OPEN: '0',
    HOME: path.join(world, 'home'), USERPROFILE: path.join(world, 'home'), APPDATA: path.join(world, 'roaming'), LOCALAPPDATA: path.join(world, 'local'),
    TEMP: path.join(world, 'tmp'), TMP: path.join(world, 'tmp'), NODE_OPTIONS: '--require="' + offline.replaceAll('\\', '/') + '"',
  });
  if (p2) {
    delete env.PI_GUI_DATA;
    env.SYSTEM_TARGET = path.join(world, '新 数据（迁移）'); fs.mkdirSync(env.SYSTEM_TARGET);
    fs.mkdirSync(path.join(profile, '.uploads')); fs.writeFileSync(path.join(profile, '.uploads/sample.bin'), Buffer.alloc(262144, 73));
    fs.writeFileSync(path.join(profile, 'session-titles.json'), JSON.stringify({ version: 1, items: [] }));
  }
  let executable = packaged ? null : require('electron'), appRoot, artifact = null;
  const entry = path.join(ROOT, p2 ? 'tests/fixtures/system-settings-p2-desktop.cjs' : 'tests/fixtures/system-settings-desktop.cjs');
  if (packaged) {
    // Never alter dist-app. Copy the built package to a fresh TEMP directory;
    // only its manifest entry is redirected to the observation bootstrap.
    // Main/preload/backend/public/icon bytes remain exactly those shipped.
    appRoot = path.join(world, 'application/resources/app');
    const { copyInto } = await import('../scripts/util.mjs');
    copyInto(world, path.join(ROOT, 'dist-app/Pi GUI-win32-x64'), 'application');
    const digest = file => require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const identities = {};
    for (const file of fs.readdirSync(path.join(ROOT, 'electron')).filter(file => file.endsWith('.cjs'))) {
      assert.equal(digest(path.join(appRoot, file)), digest(path.join(ROOT, 'electron', file)), 'packaged module ' + file);
      identities[file] = digest(path.join(appRoot, file));
    }
    for (const file of ['system-settings.js', 'system-settings-network.js', 'system-settings-storage.js', 'system-settings.css', 'index.html', 'app.js', 'api.js', 'ui/icons.js']) {
      assert.equal(digest(path.join(appRoot, 'public', file)), digest(path.join(ROOT, 'public', file)), 'packaged resource ' + file);
      identities['public/' + file] = digest(path.join(appRoot, 'public', file));
    }
    assert.equal(digest(path.join(appRoot, 'icon.ico')), digest(path.join(ROOT, 'build/icon.ico')), 'packaged Tray icon');
    const manifest = path.join(appRoot, 'package.json'), config = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    config.main = 'system-settings-observer.cjs';
    fs.writeFileSync(path.join(appRoot, config.main), `require(${JSON.stringify(entry)});\n`, { flag: 'wx' });
    fs.writeFileSync(manifest, JSON.stringify(config));
    executable = path.join(world, 'application/Pi GUI.exe');
    env.SYSTEM_APP_MAIN = path.join(appRoot, 'main.cjs');
    artifact = { bootstrapManifestOverride: true, version: config.version, executableDigest: digest(executable), modules: identities,
      backendDigest: digest(path.join(appRoot, 'server.cjs')), trayIconDigest: digest(path.join(appRoot, 'icon.ico')) };
  }
  const reports = [];
  const phases = p2 ? ['network-cache', 'prepare-migration', 'verify-migration']
    : process.argv.includes('--visual-only') ? ['visual-states']
    : process.argv.includes('--lifecycle-only') ? ['pending-save-quit', 'session-end', 'update-gates']
    : ['exercise', 'restart-tray-quit', 'default-close', 'ctrl-q', 'session-end', 'update-gates', 'pending-save-quit', 'visual-states'];
  for (const phase of phases) {
    const net = require('node:net').createServer(); await new Promise(resolve => net.listen(0, '127.0.0.1', resolve));
    const port = net.address().port; await new Promise(resolve => net.close(resolve));
    child = spawn(executable, [...(packaged ? [] : [entry]), '--user-data-dir=' + profile, '--disable-background-networking'], {
      env: { ...env, SYSTEM_PHASE: phase, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
    });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    child.stdout.on('data', data => process.stdout.write(data)); child.stderr.on('data', data => process.stderr.write(data));
    const ready = path.join(world, phase + '-ready'), ack = path.join(world, phase + '-ack');
    const deadline = Date.now() + 300000;
    while (!fs.existsSync(ready) && child.exitCode === null && Date.now() < deadline) await sleep(50);
    assert.ok(fs.existsSync(ready), phase + ' did not reach explicit cleanup; exit=' + child.exitCode + '; signal=' + child.signalCode);
    const identities = descendants(processes(), child.pid);
    assert.ok(identities.length >= 2, 'observe real desktop/backend/Pi family before exit');
    fs.writeFileSync(ack, 'observed');
    let timer; const exit = await Promise.race([exited, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('explicit exit timeout')), 30000); })]).finally(() => clearTimeout(timer));
    let residual = [];
    for (let n = 0; n < 6; n++) {
      const current = processes(); residual = identities.filter(old => current.some(item => item.ProcessId === old.ProcessId && item.CreationDate === old.CreationDate));
      if (!residual.length) break; await sleep(150);
    }
    const file = path.join(out, phase + '.json'); const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(report, { exit, processCleanup: { observed: identities.length, residual: residual.length } });
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n'); reports.push(report);
    assert.equal(exit.code, 0, phase + ' explicit exit'); assert.equal(report.failed, 0, phase + ' checks');
    assert.equal(residual.length, 0, 'no owned process identities survive ' + phase);
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ qualification: packaged ? 'packaged-bytes-observation-bootstrap-normal-sandbox' : 'production-main-normal-sandbox', artifact, checks: reports.reduce((sum, report) => sum + report.checks.length + 1, 0), reports }, null, 2) + '\n');
  console.log(`System Electron ${reports.reduce((sum, report) => sum + report.checks.length + 1, 0)} checks passed; ${reports.length} real app launches; evidence ${out}`);
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; console.error('System Electron evidence: ' + out); }).finally(() => {
  if (child?.exitCode === null && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
});
