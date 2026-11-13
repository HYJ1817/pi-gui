/* P3-C artifact acceptance: launch the built desktop executable itself.
 *
 * The SEA build stages node-pty under build/node_modules and loads it through
 * createRequire. This script proves the packaged entry (not just the source
 * tree) starts a Job-mode terminal with the rebuilt addon.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const exe = process.argv[2] || path.join(repo, 'build', 'Pi GUI.exe');
const jobMode = process.env.PI_GUI_TERMINAL_JOB_OBJECT !== '0';
const resultsDir = path.join(here, 'results');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
if (!fs.existsSync(exe)) throw new Error(`missing artifact: ${exe}`);
fs.mkdirSync(resultsDir, { recursive: true });

const world = fs.mkdtempSync(path.join(os.tmpdir(), 'p3c-artifact-'));
const project = path.join(world, 'project');
const data = path.join(world, 'data');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(data, { recursive: true });

/* Keep the packaged backend away from the real pi installation. The shim
 * stays alive, answers nothing, and exits when its parent disappears. */
const bin = path.join(world, 'bin');
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, 'fake-pi.cjs'), [
  'const parentPid = process.ppid;',
  'process.stdin.resume();',
  'setInterval(() => { try { process.kill(parentPid, 0); } catch { process.exit(0); } }, 400);',
].join('\n'));
fs.writeFileSync(path.join(bin, 'fake-pi.cmd'),
  '@echo off\r\n"%FAKE_PI_NODE%" "%~dp0fake-pi.cjs" %*\r\n', 'utf8');
const fakePi = path.join(bin, 'fake-pi.cmd');

const token = 'p3c-artifact-token';
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const value = probe.address().port;
    probe.close(() => resolve(value));
  });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* not ready */ }
    await sleep(100);
  }
  throw new Error(`timeout: ${label}`);
}

const env = {
  ...process.env,
  PI_GUI_OPEN: '0',
  PI_GUI_TOKEN: token,
  PI_GUI_DATA: data,
  PI_GUI_TERMINAL_JOB_OBJECT: jobMode ? '1' : '0',
  PI_GUI_ENABLE_TERMINAL: '1',
  PI_CWD: project,
  PI_BIN: fakePi,
  FAKE_PI_NODE: process.execPath,
  PORT: String(port),
};
const child = spawn(exe, [], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
const childExited = new Promise((resolve) => child.once('close', resolve));
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const started = Date.now();

async function api(url, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, {
    ...options,
    headers: {
      'x-pi-gui-token': token,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  return { status: response.status, body: await response.json() };
}

try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok, 30000, 'artifact health');
  const health = await api('/api/health');
  const status = await api('/api/terminal/status');
  const created = await api('/api/terminal', {
    method: 'POST',
    body: JSON.stringify({ action: 'create', cols: 100, rows: 30 }),
  });
  if (created.status !== 200 || !created.body.session) {
    throw new Error(`create failed: status=${JSON.stringify(status)} created=${JSON.stringify(created)} output=${output.slice(-800)}`);
  }
  if (created.body.session.jobMode !== jobMode) throw new Error('artifact Job mode did not match the switch');
  const id = created.body.session.id;
  const marker = `artifact_marker_${Date.now()}`;
  const activeSince = Date.now();
  if (jobMode) await sleep(15500);
  const activeAfterMs = Date.now() - activeSince;
  const markerSuffix = marker.slice('artifact_marker_'.length);
  const command = created.body.session.shell === 'PowerShell'
    ? `Write-Output ('artifact_marker_' + '${markerSuffix}')`
    : `echo artifact_marker_^${markerSuffix}`;
  const input = await api('/api/terminal', {
    method: 'POST',
    body: JSON.stringify({ action: 'input', id, data: `${command}\r` }),
  });
  let read = null;
  try {
    await waitFor(async () => {
      read = await api(`/api/terminal?id=${encodeURIComponent(id)}&since=0`);
      return read.status === 200 && read.body.session?.state === 'running'
        && read.body.text?.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').includes(marker);
    }, 15000, 'artifact marker');
  } catch (error) {
    throw new Error(`marker missing: created=${JSON.stringify(created.body)} read=${JSON.stringify(read)} output=${output.slice(-600)}`);
  }
  const stopped = await api('/api/terminal', {
    method: 'POST',
    body: JSON.stringify({ action: 'stop', id }),
  });
  await waitFor(async () => {
    const after = await api(`/api/terminal?id=${encodeURIComponent(id)}&since=0`);
    return after.status === 200 && after.body.session?.state === 'exited';
  }, 10000, 'artifact exit');
  const finalRead = await api(`/api/terminal?id=${encodeURIComponent(id)}&since=0`);
  const ok = health.status === 200 && status.status === 200 && status.body.pty === true
    && created.body.session.jobMode === jobMode && input.status === 200
    && read.body.text.includes(marker) && stopped.status === 200
    && finalRead.body.session?.state === 'exited';
  const report = {
    test: 'p3c-local-artifact',
    artifact: { path: exe, bytes: fs.statSync(exe).size, sha256: createHash('sha256').update(fs.readFileSync(exe)).digest('hex') },
    os: { release: os.release(), version: os.version(), arch: process.arch },
    env: { PORT: String(port), PI_GUI_TERMINAL_JOB_OBJECT: env.PI_GUI_TERMINAL_JOB_OBJECT, data },
    health: health.body,
    terminalStatus: status.body,
    created: created.body.session,
    marker,
    activeAfterMs,
    markerSeen: read.body.text.includes(marker),
    stopped: stopped.body,
    finalState: finalRead.body.session?.state,
    logs: path.join(data, 'logs'),
    outputTail: output.split('\n').filter(Boolean).slice(-12),
    result: { ok, elapsedMs: Date.now() - started },
  };
  const file = path.join(resultsDir, `p3c-local-artifact-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  child.kill();
  await childExited;
  try {
    fs.rmSync(world, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  } catch (error) {
    console.warn(`fixture cleanup: ${error.message}`);
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}
