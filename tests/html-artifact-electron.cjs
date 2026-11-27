'use strict';

// Explicit desktop security integration, not a second canonical test list and
// not production-UI acceptance. No dependencies are downloaded. A source UI
// module can be supplied while parallel branches are not yet integrated.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-html-artifact-security-'));
  const modulePath = path.resolve(process.env.HTML_ARTIFACT_FRAME_MODULE || path.join(__dirname, '../public/html-artifact-frame.js'));
  if (!fs.existsSync(modulePath)) throw Error('Missing production frame module; set HTML_ARTIFACT_FRAME_MODULE to its existing absolute path.');
  const executable = process.env.ELECTRON_OVERRIDE_DIST_PATH
    ? path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH, process.platform === 'win32' ? 'electron.exe' : 'electron')
    : require('electron');
  if (!fs.existsSync(executable)) throw Error('Offline Electron runtime is not available.');
  for (const name of ['home', 'appdata', 'localappdata', 'profile', 'logs', 'tmp']) fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, 'synthetic-file.txt'), 'fixture-file-must-not-be-readable');
  const env = { ...process.env, HTML_ARTIFACT_WORLD: root, HTML_ARTIFACT_FRAME_MODULE: modulePath,
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'), TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TMPDIR: path.join(root, 'tmp') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.PI_GUI_TOKEN;
  const child = spawn(executable, [path.join(__dirname, 'fixtures/html-artifact-electron.cjs')], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000); });
  const timeout = setTimeout(() => child.kill(), 90000);
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  clearTimeout(timeout);
  const file = path.join(root, 'report.json');
  if (!fs.existsSync(file)) throw Error(`Electron produced no report (exit ${result.code}, signal ${result.signal}); ${output}`);
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  report.launch = { ...result, executableSha256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),
    privateRuntimeOverride: Boolean(process.env.ELECTRON_OVERRIDE_DIST_PATH) };
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  for (const check of report.checks) console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.id}`);
  console.log(`Electron artifact security: ${report.checks.filter(item => item.pass).length}/${report.checks.length}; failed=${report.failed}; skipped=0`);
  console.log(`Evidence: ${file}`);
  if (report.failure) console.log(`Failure: ${report.failure.code} (${report.failure.exception}) at ${report.failure.stage || report.stage}`);
  if (!report.completed || report.failed || result.code !== 0) process.exitCode = 1;
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
