/* P3-C acceptance: worker env teardown reclaims the Job tree.
 *
 * The worker owns a production node-pty Job-mode terminal. The parent opens
 * process handles on shell+child first, then terminates the worker. No kill
 * API runs inside the worker, so this exercises the TSFN finalizer/env-closing
 * path that must close the last Job handle.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const exe = path.join(here, 'win32-spike.exe');
const workerFile = path.join(here, 'acceptance-env-teardown-worker.cjs');
const resultsDir = path.join(here, 'results');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const world = fs.mkdtempSync(path.join(here, '.tmp', `env-${process.pid}-`));
const stateFile = path.join(world, 'state.json');
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
const worker = new Worker(workerFile, {
  workerData: { world, stateFile, tickFile, pidFile },
});
const workerExit = new Promise((resolve) => worker.once('exit', (code) => resolve(code)));
let workerError = null;
worker.once('error', (error) => { workerError = String(error); });

try {
  await waitFor(() => fs.existsSync(stateFile), 20000, 'worker state');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (state.status.jobAssigned !== true || state.status.activeProcesses !== 2) {
    throw new Error(`worker Job not ready: ${JSON.stringify(state.status)}`);
  }
  const shellWatch = watcher('shell', state.shellPid);
  const childWatch = watcher('child', state.childPid);
  await Promise.all([shellWatch.ready(), childWatch.ready()]);
  const ticksBefore = countLines(tickFile);

  await worker.terminate();
  const code = await workerExit;
  const [shellResult, childResult] = await Promise.all([shellWatch.done(), childWatch.done()]);
  const ticksAtExit = countLines(tickFile);
  await sleep(700);
  const ticksAfter = countLines(tickFile);
  const ok = workerError === null && shellResult.wait === 0 && childResult.wait === 0
    && ticksAtExit === ticksAfter;
  const report = {
    test: 'p3c-local-env-teardown',
    os: { release: os.release(), version: os.version(), arch: process.arch },
    runtime: { node: process.versions.node },
    workerExit: code,
    workerError,
    state,
    ticks: { beforeTerminate: ticksBefore, atExit: ticksAtExit, after: ticksAfter },
    shell: shellResult,
    child: childResult,
    hostStillAlive: true,
    result: { ok, elapsedMs: Date.now() - started },
  };
  const file = path.join(resultsDir, `p3c-local-env-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  await worker.terminate().catch(() => {});
  fs.rmSync(world, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}
