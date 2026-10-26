/* Z5-1：真实 Electron Chromium 正常沙箱下的 Runtime 输入与草稿恢复专项 runner。
 * 夹具 tests/fixtures/z5-runtime-input-electron.cjs 自包含（loopback 静态服务 + 正常沙箱窗口）。
 * 产物写入 docs/assets/z5-1/（截图、results.json）。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');

const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-z51-'));
const out = path.resolve(process.env.Z51_OUTPUT || path.join(__dirname, '../docs/assets/z5-1'));
const fixture = path.join(__dirname, 'fixtures/z5-runtime-input-electron.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const reportPath = path.join(out, 'results.json');
  if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'ELECTRON_OVERRIDE_DIST_PATH']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    Z51_WORLD: world,
    Z51_OUTPUT: out,
    HOME: path.join(world, 'home'),
    USERPROFILE: path.join(world, 'home'),
    APPDATA: path.join(world, 'home/AppData/Roaming'),
    LOCALAPPDATA: path.join(world, 'home/AppData/Local'),
  });
  let spawnError = null;
  child = spawn(require('electron'), [fixture, '--user-data-dir=' + path.join(world, 'electron')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.once('error', error => { spawnError = error.code || 'spawn_error'; });
  child.stdout.on('data', data => process.stdout.write(data));
  child.stderr.on('data', data => process.stderr.write(data));
  const deadline = Date.now() + 60000;
  while (child.exitCode === null && child.signalCode === null && !spawnError && Date.now() < deadline) {
    await sleep(100);
  }
  if (spawnError) throw new Error('environment-blocked: Electron ' + spawnError);
  if (child.exitCode === null && child.signalCode === null) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    throw new Error('Electron fixture 超时未退出');
  }
  if (!fs.existsSync(reportPath)) {
    const blocked = {
      qualification: 'environment-blocked',
      failed: 1,
      failureReason: `Electron 子进程退出码 ${child.exitCode} 且未产出 results.json`,
      attemptedAt: new Date().toISOString(),
    };
    fs.writeFileSync(reportPath, JSON.stringify(blocked, null, 2) + '\n');
    throw new Error(`environment-blocked: Electron 夹具未启动（退出码 ${child.exitCode}）；详见 ${reportPath}`);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(child.exitCode, 0, '夹具必须显式成功退出');
  assert.equal(report.failed, 0);
  assert.equal(report.sandbox, true);
  assert.equal(report.contextIsolation, true);
  assert.equal(report.nodeIntegration, false);
  for (const name of [...(report.screenshots || []), ...(report.artifacts || [])]) {
    assert.ok(fs.existsSync(path.join(out, name)), `证据文件缺失：${name}`);
    assert.ok(fs.statSync(path.join(out, name)).size > 0, `证据文件为空：${name}`);
  }
  console.log(`Z5-1 Electron: ${report.rows.length}/${report.rows.length}; Chromium ${report.chromium}; 产物 ${out}`);
  fs.rmSync(world, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (Number.isInteger(child?.pid) && child.exitCode === null && child.signalCode === null) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }
  const relative = path.relative(os.tmpdir(), world);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  fs.rmSync(world, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
