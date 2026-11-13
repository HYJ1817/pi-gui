/* P3-C acceptance 3: isolated fixture backend crashes while shell+child run.
 *
 * The driver runs the production node-pty Job path. Before the crash the
 * parent opens real process handles on the shell and child; after the driver
 * aborts it waits on those handles. KILL_ON_JOB_CLOSE must take both down even
 * though no JS kill path ran.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const exe = path.join(here, 'win32-spike.exe');
const driver = path.join(here, 'acceptance-crash-driver.cjs');
const resultsDir = path.join(here, 'results');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const world = fs.mkdtempSync(path.join(here, '.tmp', `crash-${process.pid}-`));
const stateFile = path.join(world, 'state.json');
const crashFile = path.join(world, 'crash.trigger');
const tickFile = path.join(world, 'child.ticks');
const pidFile = path.join(world, 'child.pid');
fs.mkdirSync(resultsDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(25);
  }
  if (!fn()) throw new Error(`timeout: ${label}`);
  return true;
}
const countLines = (file) => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
};

function watcher(tag, pid) {
  const openFile = path.join(world, `${tag}-open.json`);
  const resultFile = path.join(world, `${tag}-result.json`);
  const child = spawn(exe, ['watch-child', '--pid', String(pid),
    '--open-out', openFile, '--out', resultFile, '--timeout', '30000'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return {
    async ready() { await waitFor(() => fs.existsSync(openFile), 10000, `${tag} open`); return JSON.parse(fs.readFileSync(openFile, 'utf8')); },
    async done() { await exited; return JSON.parse(fs.readFileSync(resultFile, 'utf8')); },
  };
}

const started = Date.now();
let driverOut = '';
const child = spawn(process.execPath, [driver, world, stateFile, crashFile, tickFile, pidFile], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { driverOut += chunk; });
child.stderr.on('data', (chunk) => { driverOut += chunk; });
const driverExit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

try {
  await waitFor(() => fs.existsSync(stateFile), 20000, 'driver state');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (state.status.jobAssigned !== true || state.status.resumeReturned !== true) {
    throw new Error(`driver Job not active: ${JSON.stringify(state.status)}`);
  }
  if (!(state.status.assignedAtMs <= state.status.resumeAtMs)) {
    throw new Error('Job assignment did not precede ResumeThread');
  }
  const shellWatch = watcher('shell', state.shellPid);
  const childWatch = watcher('child', state.childPid);
  await Promise.all([shellWatch.ready(), childWatch.ready()]);
  const ticksBefore = countLines(tickFile);

  fs.writeFileSync(crashFile, 'go');
  const exited = await Promise.race([driverExit, sleep(15000).then(() => null)]);
  if (!exited) throw new Error('driver did not crash');
  const [shellResult, childResult] = await Promise.all([shellWatch.done(), childWatch.done()]);
  const ticksAtCrash = countLines(tickFile);
  await sleep(700);
  const ticksAfter = countLines(tickFile);
  const ok = exited.code !== 0 && shellResult.wait === 0 && childResult.wait === 0
    && ticksAtCrash === ticksAfter;
  const report = {
    test: 'p3c-local-crash-reclaim',
    os: { release: os.release(), version: os.version(), arch: process.arch },
    runtime: { node: process.versions.node },
    driverExit: exited,
    state,
    ticks: { beforeCrash: ticksBefore, atCrash: ticksAtCrash, after: ticksAfter },
    shell: shellResult,
    child: childResult,
    driverOutput: driverOut.split('\n').filter(Boolean).slice(-8),
    result: { ok, elapsedMs: Date.now() - started },
  };
  const file = path.join(resultsDir, `p3c-local-crash-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  fs.rmSync(world, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}
