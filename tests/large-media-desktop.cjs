'use strict';
// Opt-in, offline real desktop qualification. Parent registers/builds separately.
// node tests/large-media-desktop.cjs [--fixture <previous TEMP world>/media] [--app-root <built resources/app>]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const SOURCE = path.resolve(__dirname, '..');
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-large-media-'));
const out = path.join(world, 'evidence'); fs.mkdirSync(out);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const arg = name => { const at = process.argv.indexOf(name); return at < 0 ? '' : process.argv[at + 1]; };
let child, exit;
async function main() {
  assert.equal(process.platform, 'win32', 'real Windows desktop required');
  const appRoot = arg('--app-root');
  if (appRoot) {
    assert.ok(path.isAbsolute(appRoot), 'explicit built application root');
    assert.ok(fs.existsSync(path.join(appRoot, 'server.cjs')), 'built backend exists');
    const { createHash } = require('node:crypto');
    const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    function verify(dir, relative = '') {
      for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
        const next = path.join(relative, entry.name);
        assert.ok(!entry.isSymbolicLink(), 'ordinary source resource');
        if (entry.isDirectory()) verify(dir, next);
        else assert.equal(digest(path.join(dir, next)), digest(path.join(appRoot, 'public', next)), 'built public byte identity');
      }
    }
    verify(path.join(SOURCE, 'public'));
    assert.equal(digest(path.join(SOURCE, 'electron/preload.cjs')), digest(path.join(appRoot, 'preload.cjs')), 'built production preload identity');
  }
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'ELECTRON_OVERRIDE_DIST_PATH']) if (process.env[key]) env[key] = process.env[key];
  for (const name of ['home', 'roaming', 'local', 'profile']) fs.mkdirSync(path.join(world, name));
  Object.assign(env, { HOME: path.join(world, 'home'), USERPROFILE: path.join(world, 'home'), APPDATA: path.join(world, 'roaming'), LOCALAPPDATA: path.join(world, 'local'), LARGE_MEDIA_WORLD: world,
    PREVIEW_APP_ROOT: appRoot, LARGE_MEDIA_FIXTURE: arg('--fixture'), LARGE_MEDIA_TRANSPORT_ONLY: process.argv.includes('--transport-only') ? '1' : '0', PREVIEW_NODE_EXECUTABLE: process.execPath, PI_GUI_OFFLINE: '1', PI_OFFLINE: '1' });
  const electron = env.ELECTRON_OVERRIDE_DIST_PATH ? path.join(env.ELECTRON_OVERRIDE_DIST_PATH, 'electron.exe') : require('electron');
  child = spawn(electron, [path.join(SOURCE, 'tests/fixtures/large-media-main.cjs')], { cwd: world, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exit = { code, signal }; resolve(); }); });
  child.stdout.on('data', chunk => process.stdout.write(chunk)); child.stderr.resume();
  let timer;
  try { await Promise.race([exited, new Promise((_r, reject) => { timer = setTimeout(() => reject(Error('desktop timeout')), 600000); })]); }
  finally { clearTimeout(timer); }
  const result = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(exit.code, 0, 'desktop explicitly passes'); assert.equal(result.failed, 0, 'no failed checks');
  console.log(`Large media desktop: ${result.passed}/${result.passed}; fixture=${path.join(world, 'media')}; evidence=${out}`);
}
main().catch(error => { process.exitCode = 1; fs.writeFileSync(path.join(out, 'runner-failure.json'), JSON.stringify({ error: error.message, exit })); console.error(`Large media desktop FAILED: ${error.message}; world=${world}`); }).finally(() => {
  if (child?.pid && !exit) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
});
