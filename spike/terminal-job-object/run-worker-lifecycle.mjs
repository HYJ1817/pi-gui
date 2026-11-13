// P3-C0 spike driver: destroy a worker_threads environment while the host
// process keeps running.
//
// The worker loads lifecycle-spike.node, creates a Job (KILL_ON_JOB_CLOSE) plus
// a ticking child process with Plan B+ (JOB_LIST + CREATE_SUSPENDED + resume),
// starts the TSFN/exit-thread fixture in mode 4, unrefs the TSFN and closes its
// port so its environment can end. The addon's cleanup thread is blocked on a
// barrier file with zero TSFN references; it never posts and only writes the
// native final state. The host:
//   1. opens the worker's child through win32-spike.exe watch-child before
//      teardown (identity-bearing handle, opened by the fixture),
//   2. observes worker 'exit' while itself keeps running,
//   3. releases the barrier; the cleanup thread closes the Job, which must kill
//      the child, and writes the native final state.
//
// Usage: node run-worker-lifecycle.mjs [path\to\win32-spike.exe]
//        ELECTRON_RUN_AS_NODE=1 electron run-worker-lifecycle.mjs [...]
// Env:   LIFECYCLE_ADDON (default ./lifecycle-spike.node)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// All order lines (native and JS) are appended by the addon as one atomic
// FILE_APPEND_DATA write. fs.appendFileSync on Windows can overlap a native
// append and leave half a line behind.
function order(addon, ev) {
  addon.order(ev);
}

function countLines(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text ? text.split('\n').filter(Boolean).length : 0;
  } catch {
    return 0;
  }
}

async function waitFile(file, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fs.existsSync(file);
}

async function waitFor(fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(label)), ms).unref();
    }),
  ]);
}

if (!isMainThread && workerData && workerData.role === 'worker-env') {
  const { addonPath, exePath, tmpDir, orderFile, stateFile, releaseFile } = workerData;
  const addon = require(addonPath);
  addon.setOrderFile(orderFile);
  const info = addon.startJobChild(exePath, tmpDir, orderFile, stateFile, releaseFile);
  order(addon, `worker-child-started pid=${info.pid} inJob=${info.inJob} active=${info.activeBeforeResume}`);
  addon.start(() => {
    order(addon, 'js-callback');
  }, 4, 60000, 64, 5);
  addon.unref();
  order(addon, 'worker-unref');
  parentPort.postMessage(info);
  order(addon, 'worker-posted');
  parentPort.close();
  order(addon, 'worker-port-closed');
} else if (isMainThread) {
  await main();
}

async function main() {
  const exePath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(here, 'win32-spike.exe');
  const addonPath = process.env.LIFECYCLE_ADDON
    ? path.resolve(process.env.LIFECYCLE_ADDON)
    : path.join(here, 'lifecycle-spike.node');
  if (!fs.existsSync(exePath)) throw new Error(`missing fixture exe: ${exePath}`);
  if (!fs.existsSync(addonPath)) throw new Error(`missing addon: ${addonPath}`);

  const base = path.join(here, '.tmp', `worker-${process.pid}-${Date.now()}`);
  fs.mkdirSync(base, { recursive: true });
  const orderFile = path.join(base, 'order.log');
  const stateFile = path.join(base, 'native-state.json');
  const releaseFile = path.join(base, 'release.signal');
  const openFile = path.join(base, 'watch-open.json');
  const watchFile = path.join(base, 'watch-result.json');
  const hostAddon = require(addonPath);
  hostAddon.setOrderFile(orderFile);
  order(hostAddon, 'host-start');

  const worker = new Worker(fileURLToPath(import.meta.url), {
    workerData: {
      role: 'worker-env',
      addonPath,
      exePath,
      tmpDir: base,
      orderFile,
      stateFile,
      releaseFile,
    },
  });
  let workerError = null;
  worker.on('error', (e) => {
    workerError = String((e && e.stack) || e);
    order(hostAddon, 'host-worker-error');
  });
  const exitPromise = new Promise((resolve) => {
    worker.once('exit', (code) => {
      order(hostAddon, `host-worker-exit code=${code}`);
      resolve(code);
    });
  });
  const info = await withTimeout(
    new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    }),
    20000,
    'worker did not report within 20 s');
  order(hostAddon, `host-worker-message pid=${info.pid}`);

  // Open the child before any teardown so the verdict is a wait on an exact
  // process object, not a PID lookup after the fact.
  const watcher = spawn(exePath, ['watch-child', '--pid', String(info.pid),
    '--open-out', openFile, '--out', watchFile, '--timeout', '30000'], { stdio: 'inherit' });
  const watcherExitPromise = new Promise((resolve) => watcher.once('exit', resolve));
  if (!(await waitFile(openFile, 10000))) throw new Error('watch-child did not open the child');
  order(hostAddon, 'host-watch-opened');
  const watchOpen = JSON.parse(fs.readFileSync(openFile, 'utf8'));
  const tickAtOpen = countLines(info.tick);

  // The worker's child must actually be running before the env is torn down.
  const ticked = await waitFor(() => countLines(info.tick) >= 3, 10000);
  const tickBeforeRelease = countLines(info.tick);

  const workerExitCode = await withTimeout(exitPromise, 15000, 'worker did not exit within 15 s');
  const tickAtWorkerExit = countLines(info.tick);
  const releaseAt = Date.now();
  fs.writeFileSync(releaseFile, 'release');
  order(hostAddon, `host-release-written workerExit=${workerExitCode}`);
  const watcherExitCode = await withTimeout(watcherExitPromise, 20000,
    'watch-child did not finish within 20 s');
  order(hostAddon, `host-watcher-exit code=${watcherExitCode}`);

  if (!(await waitFile(stateFile, 10000))) throw new Error('cleanup thread did not write native state');
  if (!(await waitFile(watchFile, 10000))) throw new Error('watch-child did not write its result');
  const watchResult = JSON.parse(fs.readFileSync(watchFile, 'utf8'));
  const nativeState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  await new Promise((r) => setTimeout(r, 500));
  const tickFinal = countLines(info.tick);
  const orderLines = fs.readFileSync(orderFile, 'utf8').trim().split('\n');

  const summary = {
    test: 'worker-env-teardown',
    runtime: process.versions.electron ? 'electron' : 'node',
    versions: {
      node: process.versions.node,
      electron: process.versions.electron || null,
      v8: process.versions.v8,
    },
    os: { release: os.release(), version: os.version(), arch: process.arch },
    execPath: process.execPath,
    workerExitCode,
    workerError,
    watcherExitCode,
    ticking: ticked,
    watchOpen,
    watchResult,
    nativeState,
    killLatencyMs: watchResult.exitAt ? watchResult.exitAt - releaseAt : null,
    ticks: {
      atOpen: tickAtOpen,
      beforeRelease: tickBeforeRelease,
      atWorkerExit: tickAtWorkerExit,
      final: tickFinal,
    },
    order: orderLines,
    dir: base,
  };
  console.log(JSON.stringify(summary, null, 2));

  const ok = workerExitCode === 0 && !workerError && watcherExitCode === 0 &&
    watchOpen.open === true && watchResult.wait === 0 && nativeState.released === true &&
    nativeState.childWait === 0 && ticked && tickFinal >= tickBeforeRelease;
  if (!ok) process.exitCode = 1;
}
